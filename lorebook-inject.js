import {
    eventSource,
    event_types,
} from '../../../events.js';
import {
    getLorebookImages,
    getLorebookImagesDataUrls,
    getCached,
    setCached,
    clearFetchCache,
} from './lorebook-images.js';
import {
    getRegexedString,
    regex_placement,
} from '../../../extensions/regex/engine.js';
import {
    DEFAULT_DEPTH,
    world_info_position,
} from '../../../world-info.js';

// ── Active Entry Cache ─────────────────

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

// ── Injection ─────────────────

/**
 * Inject lorebook images into the system message(s) that hold world info text
 * so images appear alongside the lore they illustrate.
 *
 * Called from onPromptReady in index.js — lorebook images go into the system
 * message containing world info text, NOT the chat message.
 *
 * @param {Array<object>} chat - The full chat array from CHAT_COMPLETION_PROMPT_READY
 * @param {string} quality - Image detail level ('low', 'high', 'auto')
 * @param {{ lorebookImagesEnabled: boolean, lorebookImagesMax: number }} s - Pre-read lorebook settings
 */
export async function injectLorebookImages(chat, quality, s) {
    if (!s.lorebookImagesEnabled) {
        console.debug('[PP-Lorebook] lorebookImagesEnabled is false — skipping injection');
        return;
    }

    const entries = _activeEntries;
    if (!entries || entries.size === 0) {
        console.debug('[PP-Lorebook] No cached active lorebook entries — skipping injection');
        return;
    }

    if (!Array.isArray(chat) || chat.length === 0) {
        console.debug('[PP-Lorebook] No chat array — skipping injection');
        return;
    }

    const maxTotal = Number.isFinite(s.lorebookImagesMax) ? Math.max(0, s.lorebookImagesMax) : 8;

    // ── Group entries by position ─────────────────
    // ST's world_info_position: 0=before, 1=after, 2=ANTop, 3=ANBottom,
    // 4=atDepth, 5=EMTop, 6=EMBottom, 7=outlet

    /** @type {Map<number, Array<{key: string, entry: object}>>} */
    const byPosition = new Map();
    for (const [key, entry] of entries) {
        const pos = typeof entry.position === 'number' ? entry.position : 0;
        if (!byPosition.has(pos)) byPosition.set(pos, []);
        byPosition.get(pos).push({ key, entry });
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
    // When positionLorebookImages is 'user', bypass all system-message
    // routing and inject all enabled lorebook images into the last user message.
    if (s.positionLorebookImages === 'user') {
        console.debug('[PP-Lorebook] User-position mode — injecting all lorebook images into last user message');

        function findLastUserMessage(chat) {
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i].role === 'user') return chat[i];
            }
            return null;
        }

        const userMsg = findLastUserMessage(chat);
        if (!userMsg) {
            console.debug('[PP-Lorebook] No user message found — skipping injection');
            return;
        }
        if (typeof userMsg.content === 'string') {
            userMsg.content = [{ type: 'text', text: userMsg.content }];
        }
        if (!Array.isArray(userMsg.content)) {
            console.debug('[PP-Lorebook] Cannot inject — user message content is not an array');
            return;
        }

        let injectedCount = 0;
        for (const [key, entry] of entries) {
            if (injectedCount >= maxTotal) break;
            const wName = entry.world || '';
            const uid = String(entry.uid);
            const images = getLorebookImages(wName, uid);
            const enabledImages = images.filter(img => img.enabled !== false);
            if (!enabledImages.length) continue;

            const remaining = maxTotal - injectedCount;
            const toInject = enabledImages.slice(0, remaining);

            const dataUrlByFilename = new Map();
            const uncachedFilenames = [];
            for (const img of toInject) {
                const cacheKey = 'lb::' + wName + '::' + uid + '::' + img.filename;
                const hit = getCached(cacheKey);
                if (hit !== undefined) {
                    dataUrlByFilename.set(img.filename, hit);
                } else {
                    uncachedFilenames.push(img.filename);
                }
            }

            if (uncachedFilenames.length > 0) {
                try {
                    const fresh = await getLorebookImagesDataUrls(wName, uid, uncachedFilenames);
                    for (const [filename, dataUrl] of fresh) {
                        const cacheKey = 'lb::' + wName + '::' + uid + '::' + filename;
                        setCached(cacheKey, dataUrl);
                        dataUrlByFilename.set(filename, dataUrl);
                    }
                } catch (err) {
                    console.debug(`[PP-Lorebook] Batch fetch failed for entry ${key}:`, err);
                }
            }

            for (const img of toInject) {
                const base64Data = dataUrlByFilename.get(img.filename);
                if (!base64Data) continue;
                const label = (img.label || '').trim();
                userMsg.content.push({ type: 'text', text: label ? '\n' + label : '\n' });
                userMsg.content.push({
                    type: 'image_url',
                    image_url: { url: base64Data, detail: quality },
                });
                injectedCount++;
            }
        }
        console.debug(`[PP-Lorebook] User-position mode — injected ${injectedCount} image(s)`);
        return;
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

    // ── Identify which system message holds worldInfoBefore / worldInfoAfter ─
    // In preparePromptsForChatCompletion (openai.js:1367-1375), system messages
    // are added in order: worldInfoBefore, worldInfoAfter, charDescription,
    // charPersonality, scenario, impersonate, quietPrompt, groupNudge.
    // With squash_system_messages=false, the first is worldInfoBefore,
    // the second is worldInfoAfter.
    const wiBeforeMsg = systemMessages[0].message;
    const wiAfterMsg = systemMessages.length > 1 ? systemMessages[1].message : null;

    let injectedCount = 0;

    /**
     * Ensure a message's content is in array format and inject images.
     * @param {object} targetMsg - The system message to inject into
     * @param {Array} entryList - [{key, entry}, ...] sorted by order
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
        let pos = 0;

        for (const { key, entry } of entryList) {
            if (injectedCount >= maxTotal) break;

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
                console.debug(`[PP-Lorebook] Entry ${key} text not found in system message at/after pos=${pos}`);
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

            // Get and inject images for this entry right after its text
            const images = getLorebookImages(entry.world || '', String(entry.uid));
            if (!images || images.length === 0) continue;

            const enabledImages = images.filter(img => img.enabled !== false);
            if (enabledImages.length === 0) continue;

            const remaining = maxTotal - injectedCount;
            const toInject = enabledImages.slice(0, remaining);
            if (toInject.length === 0) continue;

            // Separate cached vs. uncached images for this entry
            const wName = entry.world || '';
            const uid = String(entry.uid);
            const dataUrlByFilename = new Map();
            const uncachedFilenames = [];

            for (const img of toInject) {
                const cacheKey = 'lb::' + wName + '::' + uid + '::' + img.filename;
                const hit = getCached(cacheKey);
                if (hit !== undefined) {
                    dataUrlByFilename.set(img.filename, hit);
                } else {
                    uncachedFilenames.push(img.filename);
                }
            }

            // Batch-read uncached images in one IndexedDB transaction + parallel conversion
            if (uncachedFilenames.length > 0) {
                try {
                    const fresh = await getLorebookImagesDataUrls(wName, uid, uncachedFilenames);
                    for (const [filename, dataUrl] of fresh) {
                        const cacheKey = 'lb::' + wName + '::' + uid + '::' + filename;
                        setCached(cacheKey, dataUrl);
                        dataUrlByFilename.set(filename, dataUrl);
                    }
                } catch (err) {
                    console.debug(`[PP-Lorebook] Batch fetch failed for entry ${key}:`, err);
                }
            }

            // Inject images right after this entry's text block
            for (const img of toInject) {
                const base64Data = dataUrlByFilename.get(img.filename);
                if (!base64Data) {
                    console.debug(`[PP-Lorebook] No data URL for ${img.filename} in entry ${key} — skipping`);
                    continue;
                }
                try {
                    const label = (img.label || '').trim();
                    rebuilt.push({ type: 'text', text: label ? '\n' + label : '\n' });
                    rebuilt.push({
                        type: 'image_url',
                        image_url: { url: base64Data, detail: quality },
                    });
                    injectedCount++;
                    console.debug(`[PP-Lorebook] Injected image from entry ${key} (${injectedCount}/${maxTotal}), base64 len=${base64Data?.length || 0}`);
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

        targetMsg.content = rebuilt;
    }

    // ── Inject position=0 entries into worldInfoBefore message ─
    const beforeEntries = (byPosition.get(0) || [])
        .sort((a, b) => (b.entry.order || 100) - (a.entry.order || 100));
    if (beforeEntries.length > 0) {
        console.debug(`[PP-Lorebook] Injecting ${beforeEntries.length} position=0 entries into worldInfoBefore system message`);
        await injectIntoSystemMsg(wiBeforeMsg, beforeEntries);
    }

    // ── Inject position=1 entries into worldInfoAfter message ─
    const afterEntries = (byPosition.get(1) || [])
        .sort((a, b) => (b.entry.order || 100) - (a.entry.order || 100));
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
        if (injectedCount >= maxTotal) break;

        const target = (pos === 2 || pos === 3) ? anMsg
            : (pos === 5 || pos === 6) ? emMsg
            : wiBeforeMsg;
        if (!target) continue;

        const label = pos === 2 ? 'ANTop' : pos === 3 ? 'ANBottom' : pos === 5 ? 'EMTop' : pos === 6 ? 'EMBottom' : `pos=${pos}`;
        console.debug(`[PP-Lorebook] Injecting ${entryList.length} ${label} entries into ${target === anMsg ? "Author's Note" : target === emMsg ? 'Example Messages' : 'worldInfoBefore'} system message`);
        await injectIntoSystemMsg(target, entryList);
    }

    console.debug(`[PP-Lorebook] Injection complete — injected ${injectedCount} image(s) total`);
}

// ── Initialisation ─────────────────

/**
 * Initialise the lorebook image injection pipeline.
 * Sets up event listeners for WORLD_INFO_ACTIVATED and CHAT_CHANGED.
 * Called from index.js activate().
 */
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
