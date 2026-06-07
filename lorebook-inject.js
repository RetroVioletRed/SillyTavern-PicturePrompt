import {
    eventSource,
    event_types,
} from '../../../events.js';
import {
    getLorebookSettings,
    getLorebookImages,
    getLorebookImage,
    blobToDataURL,
} from './lorebook-images.js';

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
 */
export async function injectLorebookImages(chat, quality) {
    const s = getLorebookSettings();
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

    const maxTotal = s.lorebookImagesMax || 8;

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

        for (const { key, entry } of entryList) {
            if (injectedCount >= maxTotal) break;

            const images = getLorebookImages(entry.world || '', String(entry.uid));
            if (!images || images.length === 0) continue;

            const enabledImages = images.filter(img => img.enabled !== false);
            if (enabledImages.length === 0) continue;

            const remaining = maxTotal - injectedCount;
            const toInject = enabledImages.slice(0, remaining);

            for (const img of toInject) {
                try {
                    const wName = entry.world || '';
                    const record = await getLorebookImage(wName, String(entry.uid), img.filename);
                    if (!record || !record.blob) {
                        console.debug(`[PP-Lorebook] No blob found for image in entry ${key} — skipping`);
                        continue;
                    }

                    const base64Data = await blobToDataURL(record.blob);
                    if (!base64Data) {
                        console.debug(`[PP-Lorebook] Failed to convert blob to base64 for entry ${key} — skipping`);
                        continue;
                    }

                    // Inject label + image at the end of the system message content
                    const label = (img.label || '').trim();
                    targetMsg.content.push({ type: 'text', text: label ? '\n' + label : '\n' });
                    targetMsg.content.push({
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

    // ── Inject remaining positions into the first system message ─
    for (const [pos, entryList] of byPosition) {
        if (pos === 0 || pos === 1) continue; // already handled
        if (injectedCount >= maxTotal) break;
        console.debug(`[PP-Lorebook] Injecting ${entryList.length} position=${pos} entries into system message`);
        await injectIntoSystemMsg(wiBeforeMsg, entryList);
    }

    console.debug(`[PP-Lorebook] Injection complete — injected ${injectedCount} image(s) total`);
}

// ── Initialisation ─────────────────

/**
 * Initialise the lorebook image injection pipeline.
 * Sets up event listeners for WORLD_INFO_ACTIVATED and CHAT_CHANGED.
 * Called from index.js activate().
 */
export function initLorebookInject() {
    console.debug('[PP-Lorebook] Initialising lorebook image injection pipeline');

    /**
     * WORLD_INFO_ACTIVATED handler.
     * Receives an array of activated entry objects (each with .uid and custom fields).
     * Caches them keyed by `${worldName}.${entryUid}`.
     */
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, (entries) => {
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
    });

    /**
     * CHAT_CHANGED handler.
     * Clears the cached entries because the world info context changes with the chat.
     */
    eventSource.on(event_types.CHAT_CHANGED, () => {
        console.debug('[PP-Lorebook] CHAT_CHANGED — clearing lorebook entry cache');
        _activeEntries.clear();
    });

    console.debug('[PP-Lorebook] Lorebook image injection pipeline initialised');
}
