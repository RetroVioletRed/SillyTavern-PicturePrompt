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
 * Inject lorebook images into a message's content array.
 * Called from onPromptReady in index.js — lorebook images go
 * AFTER character gallery and BEFORE persona avatar.
 * @param {object} msg - The target message object with a .content array
 * @param {string} quality - Image detail level ('low', 'high', 'auto')
 */
export async function injectLorebookImages(msg, quality) {
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

    const maxTotal = s.lorebookImagesMax || 8;
    let injectedCount = 0;

    for (const [key, entry] of entries) {
        if (injectedCount >= maxTotal) break;

        /** @type {Array<{filename?: string, enabled?: boolean, label?: string}>|undefined} */
        const images = getLorebookImages(entry.world || '', String(entry.uid));
        if (!images || images.length === 0) {
            console.debug(`[PP-Lorebook] Entry ${key} has no picturePromptImages — skipping`);
            continue;
        }

        // Filter to enabled images only
        const enabledImages = images.filter(img => img.enabled !== false);
        if (enabledImages.length === 0) {
            console.debug(`[PP-Lorebook] Entry ${key} has no enabled images — skipping`);
            continue;
        }

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

                // Always insert a text block before the image — prevents
                // consecutive image_url blocks which some APIs silently drop
                const label = (img.label || '').trim();
                msg.content.push({ type: 'text', text: label ? '\n' + label : '\n' });

                msg.content.push({
                    type: 'image_url',
                    image_url: {
                        url: base64Data,
                        detail: quality,
                    },
                });

                injectedCount++;
                console.debug(`[PP-Lorebook] Injected image from entry ${key} (${injectedCount}/${maxTotal}), base64 len=${base64Data?.length || 0}`);
            } catch (err) {
                console.debug(`[PP-Lorebook] Failed to inject image from entry ${key}:`, err);
            }
        }
    }

    console.debug(`[PP-Lorebook] Injection complete — injected ${injectedCount} image(s)`);
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
