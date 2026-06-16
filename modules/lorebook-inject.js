import {
    eventSource,
    event_types,
} from '../../../../events.js';
import {
    clearFetchCache,
} from './lorebook-images.js';
import {
    getRegexedString,
    regex_placement,
} from '../../../../extensions/regex/engine.js';
import {
    checkWorldInfo,
    DEFAULT_DEPTH,
    world_info_include_names,
    world_info_position,
} from '../../../../world-info.js';
import { getContext } from '../../../../extensions.js';

// ── Active Entry Cache ─────────────────

/** Safety net: if checkWorldInfo hangs, bail after this many ms. */
const ENSURE_CACHE_TIMEOUT_MS = 5000;

/**
 * Cache of active lorebook entries keyed by `${worldName}.${entryUid}`.
 * Populated on WORLD_INFO_ACTIVATED, cleared on CHAT_CHANGED.
 * @type {Map<string, object>}
 */
let _activeEntries = new Map();

/**
 * Get the cached Map of active lorebook entries.
 * Key = `${worldName}.${entryUid}`, value = full entry object.
 * @returns {Map<string, object>}
 */
export function getCachedActiveEntries() {
    return _activeEntries;
}

// ── Proactive Cache Population ─────────────────

/**
 * Populate _activeEntries if empty by calling checkWorldInfo directly
 * with a dry run, then extracting activated entries from the result.
 * Avoids firing WORLD_INFO_ACTIVATED (no side-effect on other extensions).
 */
async function ensureActiveEntriesCache() {
    if (_activeEntries.size > 0) return;

    const context = getContext();
    const chat = context.chat;
    if (!chat || !chat.length) return;

    // Build chatForWI: filter system messages, reverse, optional name prefix
    const coreChat = chat.filter(x => !x.is_system);
    const chatForWI = coreChat.map(x => world_info_include_names ? `${x.name}: ${x.mes}` : x.mes).reverse();

    // Build globalScanData from current character/persona
    const fields = context.getCharacterCardFields();
    const globalScanData = {
        personaDescription: fields.persona || '',
        characterDescription: fields.description || '',
        characterPersonality: fields.personality || '',
        characterDepthPrompt: fields.charDepthPrompt || '',
        scenario: fields.scenario || '',
        creatorNotes: fields.creatorNotes || '',
        trigger: 'normal',
    };

    // Generous maxContext — scan all entries regardless of token budget
    const maxContext = 100000;

    try {
        const result = await Promise.race([
            checkWorldInfo(chatForWI, maxContext, true, globalScanData),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ENSURE_CACHE_TIMEOUT_MS)),
        ]);
        if (result.allActivatedEntries && result.allActivatedEntries.size > 0) {
            clearFetchCache();
            _activeEntries.clear();
            for (const entry of result.allActivatedEntries) {
                if (!entry || entry.uid === undefined) continue;
                const worldName = entry.world || '';
                const key = `${worldName}.${entry.uid}`;
                _activeEntries.set(key, entry);
            }
            console.debug(`[PP-Lorebook] Proactively cached ${_activeEntries.size} active entries from checkWorldInfo`);
        }
    } catch (err) {
        if (err?.message === 'Timeout') {
            console.debug('[PP-Lorebook] Proactive world info check timed out after ' + ENSURE_CACHE_TIMEOUT_MS + 'ms — cache left empty');
        } else {
            console.debug('[PP-Lorebook] Proactive world info check failed — cache left empty:', err);
        }
    }
}

/**
 * Get active lorebook entries, proactively populating cache if empty.
 * Prefer this over getCachedActiveEntries() to avoid stale-cache races.
 * @returns {Promise<Map<string, object>>}
 */
export async function getActiveEntries() {
    await ensureActiveEntriesCache();
    return _activeEntries;
}

// ── Injection ─────────────────

/**
 * Inject lorebook images into the system message(s) that hold world info text
 * so images appear alongside the lore they illustrate.
 *
 * Images come pre-resolved from the InjectionPlan — no duplicate fetching.
 * Routing logic (position grouping, system message text matching) unchanged.
 *
 * @param {Array<object>} chat - The full chat array from CHAT_COMPLETION_PROMPT_READY
 * @param {object} lorebookPlan - { enabled, quality, position, maxTotal, entries }
 * @param {function} getUserTarget - Function to find the last user message
 */
export async function injectLorebookImages(chat, lorebookPlan, getUserTarget) {
    if (!lorebookPlan.enabled) {
        console.debug('[PP-Lorebook] lorebookImagesEnabled is false — skipping injection');
        return;
    }

    if (!lorebookPlan.entries.length) {
        console.debug('[PP-Lorebook] No active lorebook entries — skipping injection');
        return;
    }

    if (!Array.isArray(chat) || chat.length === 0) {
        console.debug('[PP-Lorebook] No chat array — skipping injection');
        return;
    }

    const quality = lorebookPlan.quality;
    const maxTotal = lorebookPlan.maxTotal;

    // ── Group entries by position ─────────────────
    // ST's world_info_position: 0=before, 1=after, 2=ANTop, 3=ANBottom,
    // 4=atDepth, 5=EMTop, 6=EMBottom, 7=outlet

    /** @type {Map<number, Array<{key: string, entry: object, images: Array}>>} */
    const byPosition = new Map();
    for (const item of lorebookPlan.entries) {
        const pos = typeof item.entry.position === 'number' ? item.entry.position : 0;
        if (!byPosition.has(pos)) byPosition.set(pos, []);
        byPosition.get(pos).push(item);
    }

    // ── Find system messages ─────────────────
    const systemMessages = [];
    for (let i = 0; i < chat.length; i++) {
        if (chat[i].role === 'system') {
            systemMessages.push({ index: i, message: chat[i] });
        }
    }

    if (systemMessages.length === 0) {
        console.debug('[PP-Lorebook] No system messages in chat — skipping injection');
        return;
    }

    console.debug(`[PP-Lorebook] Found ${systemMessages.length} system message(s)`);

    // ── User-position shortcut ─────────────────
    // When position is 'user', bypass all system-message routing and inject
    // all enabled lorebook images into the last user message.
    if (lorebookPlan.position === 'user') {
        console.debug('[PP-Lorebook] User-position mode — injecting all lorebook images into last user message');

        const userMsg = getUserTarget(chat);
        if (!userMsg) {
            console.debug('[PP-Lorebook] No user message found — falling back to system-position routing');
        } else {
            if (typeof userMsg.content === 'string') {
                userMsg.content = [{ type: 'text', text: userMsg.content }];
            }
            if (!Array.isArray(userMsg.content)) {
                console.debug('[PP-Lorebook] Cannot inject — user message content is not an array');
                return;
            }

            let injectedCount = 0;
            for (const item of lorebookPlan.entries) {
                if (injectedCount >= maxTotal) break;
                for (const img of item.images) {
                    if (injectedCount >= maxTotal) break;
                    const label = (img.label || '').trim();
                    userMsg.content.push({ type: 'text', text: label ? '\n' + label : '\n' });
                    userMsg.content.push({
                        type: 'image_url',
                        image_url: { url: img.dataUrl, detail: quality },
                    });
                    injectedCount++;
                }
            }
            console.debug(`[PP-Lorebook] User-position mode — injected ${injectedCount} image(s)`);
            return;
        }
    }

    // ── Identify Author's Note and Example Messages ─────────────────
    // ST places Author's Note (positions 2,3) and Example Messages (5,6)
    // as the last system messages, after world info and character data.
    // The author's note is wrapped with "[Author's note:" — scan for it.
    let anMsg = null;
    let emMsg = null;
    for (let i = systemMessages.length - 1; i >= 2; i--) {
        const content = systemMessages[i].message.content;
        const text = typeof content === 'string' ? content
            : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('') : '';
        if (text.includes("[Author's note:")) {
            anMsg = systemMessages[i].message;
            if (i + 1 < systemMessages.length) {
                emMsg = systemMessages[i + 1].message;
            }
            break;
        }
    }
    console.debug(`[PP-Lorebook] Author's Note msg: ${anMsg ? 'found' : 'not found'}, Example Msgs: ${emMsg ? 'found' : 'not found'}`);

    // ── Find which system messages hold worldInfoBefore / worldInfoAfter ─
    // ST's populateChatCompletion inserts 'main' between them, so we search
    // by resolved entry text rather than assuming fixed indices.
    const findWorldInfoMessage = (entryList) => {
        if (!entryList || !entryList.length) return null;
        const e = entryList[0].entry;
        const isAtDepth = e.position === world_info_position.atDepth;
        const regexDepth = isAtDepth ? (e.depth ?? DEFAULT_DEPTH) : undefined;
        const needle = getRegexedString(e.content || '', regex_placement.WORLD_INFO, { depth: regexDepth, isMarkdown: false, isPrompt: true });
        if (!needle) return null;
        for (const sm of systemMessages) {
            const text = typeof sm.message.content === 'string'
                ? sm.message.content
                : Array.isArray(sm.message.content)
                    ? sm.message.content.filter(b => b.type === 'text').map(b => b.text).join('')
                    : '';
            if (text.includes(needle)) return sm.message;
        }
        return null;
    };
    // Index-based fallbacks — overridden by content search below
    let wiBeforeMsg = systemMessages[0]?.message;
    let wiAfterMsg = systemMessages.length > 1 ? systemMessages[1]?.message : null;

    /**
     * Ensure a message's content is in array format and inject images
     * right after each entry's resolved text. Images are pre-resolved
     * in the plan — no fetching needed.
     *
     * @param {object} targetMsg - The system message to inject into
     * @param {Array} entryList - [{key, entry, images}, ...] sorted by order
     */
    async function injectIntoSystemMsg(targetMsg, entryList) {
        // Convert content from string to array if needed
        if (typeof targetMsg.content === 'string') {
            targetMsg.content = [{ type: 'text', text: targetMsg.content }];
        }
        if (!Array.isArray(targetMsg.content)) {
            console.debug('[PP-Lorebook] Cannot inject — message content is neither string nor array');
            return;
        }

        // Gather all text from content blocks into one string (handles format wrappers)
        let fullText = '';
        const nonTextBlocks = [];
        for (const block of targetMsg.content) {
            if (block.type === 'text') {
                fullText += block.text;
            } else {
                nonTextBlocks.push(block);
            }
        }

        if (!fullText) {
            console.debug('[PP-Lorebook] No text content in system message — skipping injection');
            return;
        }

        // Rebuild content array: for each entry, find its text, insert images right after
        const rebuilt = [];
        const fallbackEntries = [];
        let pos = 0;

        for (const item of entryList) {
            const { key, entry, images } = item;
            if (!images || !images.length) continue;

            // Resolve entry content the same way ST does (macros, {{user}}, etc.)
            const isAtDepth = entry.position === world_info_position.atDepth;
            const regexDepth = isAtDepth ? (entry.depth ?? DEFAULT_DEPTH) : undefined;
            const resolvedContent = getRegexedString(
                entry.content || '',
                regex_placement.WORLD_INFO,
                { depth: regexDepth, isMarkdown: false, isPrompt: true },
            );

            if (!resolvedContent) continue;

            // Find the resolved entry text in the full text from current position
            const foundIdx = fullText.indexOf(resolvedContent, pos);
            if (foundIdx === -1) {
                console.debug(`[PP-Lorebook] Entry ${key} text not found in system message — falling back to append`);
                fallbackEntries.push(item);
                continue;
            }

            // Append any gap text between previous entry and this one (format wrappers, separators, etc.)
            if (foundIdx > pos) {
                rebuilt.push({ type: 'text', text: fullText.substring(pos, foundIdx) });
            }

            const entryEnd = foundIdx + resolvedContent.length;

            // Add this entry's text block
            rebuilt.push({ type: 'text', text: fullText.substring(foundIdx, entryEnd) });

            pos = entryEnd;

            // Inject pre-resolved images right after this entry's text block
            for (const img of images) {
                try {
                    const label = (img.label || '').trim();
                    rebuilt.push({ type: 'text', text: label ? '\n' + label : '\n' });
                    rebuilt.push({
                        type: 'image_url',
                        image_url: { url: img.dataUrl, detail: quality },
                    });
                } catch (err) {
                    console.debug(`[PP-Lorebook] Failed to inject image from entry ${key}:`, err);
                }
            }
        }

        // Append remaining text after the last processed entry
        if (pos < fullText.length) {
            rebuilt.push({ type: 'text', text: fullText.substring(pos) });
        }

        // Append any non-text blocks that existed before (e.g. from prior injections)
        rebuilt.push(...nonTextBlocks);

        // Fallback: append images for entries whose text wasn't found
        for (const item of fallbackEntries) {
            const { key, images } = item;
            if (!images || !images.length) continue;
            for (const img of images) {
                try {
                    const label = (img.label || '').trim();
                    rebuilt.push({ type: 'text', text: label ? '\n' + label : '\n' });
                    rebuilt.push({
                        type: 'image_url',
                        image_url: { url: img.dataUrl, detail: quality },
                    });
                } catch (err) {
                    console.debug(`[PP-Lorebook] Failed to inject fallback image from entry ${key}:`, err);
                }
            }
        }

        targetMsg.content = rebuilt;
    }

    // ── Inject position=0 entries into worldInfoBefore message ─
    const beforeEntries = (byPosition.get(0) || [])
        .sort((a, b) => (a.entry.order || 100) - (b.entry.order || 100));
    wiBeforeMsg = findWorldInfoMessage(beforeEntries) || wiBeforeMsg;
    if (beforeEntries.length > 0) {
        console.debug(`[PP-Lorebook] Injecting ${beforeEntries.length} position=0 entries into worldInfoBefore system message`);
        await injectIntoSystemMsg(wiBeforeMsg, beforeEntries);
    }

    // ── Inject position=1 entries into worldInfoAfter message ─
    const afterEntries = (byPosition.get(1) || [])
        .sort((a, b) => (a.entry.order || 100) - (b.entry.order || 100));
    wiAfterMsg = findWorldInfoMessage(afterEntries) || wiAfterMsg;
    if (afterEntries.length > 0 && wiAfterMsg && wiAfterMsg !== wiBeforeMsg) {
        console.debug(`[PP-Lorebook] Injecting ${afterEntries.length} position=1 entries into worldInfoAfter system message`);
        await injectIntoSystemMsg(wiAfterMsg, afterEntries);
    } else if (afterEntries.length > 0) {
        // Fallback: only one system message — inject all into it
        console.debug(`[PP-Lorebook] Only one system message — injecting position=1 entries into it as well`);
        await injectIntoSystemMsg(wiBeforeMsg, afterEntries);
    }

    // ── Inject remaining positions into their correct system messages ─
    for (const [pos, entryList] of byPosition) {
        if (pos === 0 || pos === 1) continue; // already handled

        const target = (pos === 2 || pos === 3) ? anMsg
            : (pos === 5 || pos === 6) ? emMsg
            : wiBeforeMsg;
        if (!target) continue;

        const label = pos === 2 ? 'ANTop' : pos === 3 ? 'ANBottom' : pos === 5 ? 'EMTop' : pos === 6 ? 'EMBottom' : `pos=${pos}`;
        console.debug(`[PP-Lorebook] Injecting ${entryList.length} ${label} entries into ${target === anMsg ? "Author's Note" : target === emMsg ? 'Example Messages' : 'worldInfoBefore'} system message`);
        await injectIntoSystemMsg(target, entryList);
    }

    console.debug('[PP-Lorebook] Injection complete');
}

// ── Initialisation ─────────────────

/**
 * WORLD_INFO_ACTIVATED handler.
 * Receives entries, clears fetch cache, and rebuilds the active entry map.
 */
function _onWorldInfoActivated(entries) {
    clearFetchCache();
    try {
        if (!Array.isArray(entries) || entries.length === 0) {
            console.debug('[PP-Lorebook] WORLD_INFO_ACTIVATED — no entries received');
            _activeEntries.clear();
            return;
        }

        _activeEntries.clear();
        for (const entry of entries) {
            if (!entry || entry.uid === undefined) continue;
            const worldName = entry.world || '';
            const key = `${worldName}.${entry.uid}`;
            _activeEntries.set(key, entry);
        }

        console.debug(`[PP-Lorebook] Cached ${_activeEntries.size} active lorebook entries from WORLD_INFO_ACTIVATED`);
    } catch (err) {
        console.debug('[PP-Lorebook] Error processing WORLD_INFO_ACTIVATED:', err);
        _activeEntries.clear();
    }
}

/**
 * CHAT_CHANGED handler.
 * Clears cached entries because world info context changes with the chat.
 */
function _onLorebookChatChanged() {
    console.debug('[PP-Lorebook] CHAT_CHANGED — clearing lorebook entry cache');
    _activeEntries.clear();
}

/**
 * Initialise the lorebook image injection pipeline.
 * Sets up event listeners for WORLD_INFO_ACTIVATED and CHAT_CHANGED.
 * Called from index.js activate().
 */
export function initLorebookInject() {
    console.debug('[PP-Lorebook] Initialising lorebook image injection pipeline');

    eventSource.on(event_types.WORLD_INFO_ACTIVATED, _onWorldInfoActivated);
    eventSource.on(event_types.CHAT_CHANGED, _onLorebookChatChanged);

    console.debug('[PP-Lorebook] Lorebook image injection pipeline initialised');
}

/**
 * Deactivate lorebook injection — remove event listeners.
 * Called from the main deactivate() in index.js.
 */
export function deactivateLorebookInject() {
    eventSource.removeListener(event_types.WORLD_INFO_ACTIVATED, _onWorldInfoActivated);
    eventSource.removeListener(event_types.CHAT_CHANGED, _onLorebookChatChanged);
    _activeEntries.clear();
    console.debug('[PP-Lorebook] Lorebook image injection pipeline deactivated');
}
