/**
 * injection-plan.js — Unified injection plan builder for Picture Prompt.
 *
 * Resolves all image sources (char avatar, persona avatar, persona extras,
 * gallery, lorebook) into a single plan object. Both token estimation and
 * prompt injection consume the same plan — no duplicate settings resolution
 * or image fetching.
 *
 * @module injection-plan
 */

import { characters, this_chid, user_avatar } from '../../../../../script.js';
import { blobToDataURL, dbGetAll, log } from './storage.js';
import { getSettings, getSourceQuality, getCharacterAvatarUrl, getPersonaAvatarUrl, getMetaForPersona, isGroupChat } from './settings.js';
import { getCharGalleryMeta, getCharGalleryFolder } from './gallery-images.js';
import { getLorebookSettings, getLorebookImages, getLorebookImagesDataUrls, getCached, setCached } from './lorebook-images.js';
import { getActiveEntries } from './lorebook-inject.js';

// ── Fetch Helpers ─────────────────────────

/**
 * Fetch an image URL (for avatars/gallery) and convert to base64. Cached.
 */
export async function urlToBase64(url) {
    const cacheKey = 'url::' + url;
    const cached = getCached(cacheKey);
    if (cached !== undefined) return cached;

    try {
        const response = await fetch(url, { cache: 'force-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const dataUrl = await blobToDataURL(await response.blob());
        if (dataUrl) setCached(cacheKey, dataUrl);
        return dataUrl;
    } catch (err) {
        log.warn('Failed to fetch image:', url, err);
        return null;
    }
}

/**
 * Run async tasks with a concurrency limit.
 * @param {number} concurrency
 * @param {(() => Promise<any>)[]} tasks
 * @returns {Promise<any[]>}
 */
async function poolAsync(concurrency, tasks) {
    const results = new Array(tasks.length);
    const queue = tasks.map((task, i) => ({ task, i }));
    const worker = async () => {
        while (queue.length) {
            const { task, i } = queue.shift();
            results[i] = await task();
        }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
}

/**
 * Get extra images for a persona: reads metadata, fetches blobs,
 * converts to base64 data URLs. Result is cached so estimation
 * and injection share one fetch.
 */
export async function getExtraImagesForInjection(avatarId) {
    const cacheKey = 'extra::' + avatarId;
    const cached = getCached(cacheKey);
    if (cached !== undefined) return cached;

    const metaList = getMetaForPersona(avatarId);
    const enabledMeta = metaList.filter(m => m.enabled !== false);
    if (!enabledMeta.length) return [];

    const keys = enabledMeta.map(m => `${avatarId}::${m.filename}`);
    const records = await dbGetAll(keys);

    const dataUrls = await Promise.all(
        records.map(r => r?.blob ? blobToDataURL(r.blob) : Promise.resolve(null))
    );

    const results = [];
    for (let i = 0; i < enabledMeta.length; i++) {
        if (dataUrls[i]) {
            results.push({
                filename: enabledMeta[i].filename,
                dataUrl: dataUrls[i],
                label: enabledMeta[i].label || '',
            });
        }
    }
    setCached(cacheKey, results);
    return results;
}

// ── Plan Builder ──────────────────────────

/**
 * Build a unified injection plan — resolves all settings, fetches all
 * image data URLs, applies max counts, returns a single object that
 * both token estimation and prompt injection consume.
 *
 * @returns {Promise<object>} InjectionPlan
 */
export async function buildInjectionPlan() {
    const s = getSettings();

    /** @type {InjectionPlan} */
    const plan = {
        char:    { enabled: false, dataUrl: null, label: '', quality: 'auto', position: 'system', error: null },
        persona: { enabled: false, dataUrl: null, label: '', quality: 'auto', position: 'system', error: null },
        extras:  { enabled: false, images: [], quality: 'auto', position: 'system', maxCount: 0 },
        gallery: { enabled: false, images: [], quality: 'auto', position: 'system', maxCount: 0 },
        lorebook:{ enabled: false, entries: [], quality: 'auto', position: 'system', maxTotal: 0 },
    };

    // ── Character avatar ───────────────────
    if (s.injectChar && !isGroupChat()) {
        plan.char.enabled = true;
        plan.char.position = s.positionCharAvatar || 'system';
        plan.char.quality = getSourceQuality(s.qualityCharAvatar);
        plan.char.label = s.labelChar || '';
        const url = getCharacterAvatarUrl();
        if (url) {
            plan.char.dataUrl = await urlToBase64(url);
            if (!plan.char.dataUrl) plan.char.error = 'char-fetch';
        } else {
            plan.char.error = 'char-missing';
        }
    }

    // ── Persona avatar ─────────────────────
    if (s.injectPersona) {
        plan.persona.enabled = true;
        plan.persona.position = s.positionPersonaAvatar || 'system';
        plan.persona.quality = getSourceQuality(s.qualityPersonaAvatar);
        plan.persona.label = s.labelUser || '';
        const url = getPersonaAvatarUrl();
        if (url) {
            plan.persona.dataUrl = await urlToBase64(url);
            if (!plan.persona.dataUrl) plan.persona.error = 'persona-fetch';
        } else {
            plan.persona.error = 'persona-missing';
        }
    }

    // ── Persona extra images ───────────────
    if (s.extraImagesEnabled && user_avatar) {
        plan.extras.enabled = true;
        plan.extras.position = s.positionExtraImages || 'system';
        plan.extras.quality = getSourceQuality(s.qualityExtraImages);
        plan.extras.maxCount = Number.isFinite(s.maxExtraImages) ? Math.max(0, s.maxExtraImages) : 8;
        const allExtras = await getExtraImagesForInjection(user_avatar);
        plan.extras.images = allExtras.slice(0, plan.extras.maxCount);
    }

    // ── Character gallery images ───────────
    if (s.charExtraImagesEnabled && !isGroupChat()) {
        const chId = Number(this_chid);
        if (chId >= 0 && characters?.[chId]?.avatar) {
            const avatarId = characters[chId].avatar;
            const meta = getCharGalleryMeta(avatarId);
            const enabledFilenames = Object.entries(meta)
                .filter(([, v]) => v.enabled)
                .map(([k]) => k);

            if (enabledFilenames.length > 0) {
                plan.gallery.enabled = true;
                plan.gallery.position = s.positionGalleryImages || 'system';
                plan.gallery.quality = getSourceQuality(s.qualityGalleryImages);
                plan.gallery.maxCount = Number.isFinite(s.charExtraImagesMax) ? Math.max(0, s.charExtraImagesMax) : 8;
                const folder = getCharGalleryFolder();
                if (folder) {
                    const toFetch = enabledFilenames.slice(0, plan.gallery.maxCount);
                    const tasks = toFetch.map((filename) => () => {
                        const url = `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
                        return urlToBase64(url).then(dataUrl => dataUrl ? { filename, dataUrl, label: meta[filename]?.label || '' } : null);
                    });
                    const results = await poolAsync(4, tasks);
                    plan.gallery.images = results.filter(Boolean);
                }
            }
        }
    }

    // ── Lorebook images ────────────────────
    if (s.lorebookImagesEnabled) {
        const lbSettings = getLorebookSettings();
        plan.lorebook.enabled = true;
        plan.lorebook.position = s.positionLorebookImages || 'system';
        plan.lorebook.quality = getSourceQuality(s.qualityLorebookImages);
        plan.lorebook.maxTotal = Number.isFinite(lbSettings.lorebookImagesMax) ? Math.max(0, lbSettings.lorebookImagesMax) : 4;

        const entries = await getActiveEntries();
        if (entries.size > 0) {
            // Order entries to match injection routing:
            // position 0 (sorted by order), position 1 (sorted by order), then others (insertion order)
            const byPosition = new Map();
            for (const [key, entry] of entries) {
                const pos = typeof entry.position === 'number' ? entry.position : 0;
                if (!byPosition.has(pos)) byPosition.set(pos, []);
                byPosition.get(pos).push({ key, entry });
            }

            const ordered = [];
            const addGroup = (pos, sort) => {
                const group = byPosition.get(pos);
                if (!group) return;
                if (sort) group.sort((a, b) => (a.entry.order || 100) - (b.entry.order || 100));
                ordered.push(...group);
            };
            addGroup(0, true);
            addGroup(1, true);
            for (const [pos, group] of byPosition) {
                if (pos !== 0 && pos !== 1) ordered.push(...group);
            }

            // Resolve images for each entry, capped by maxTotal
            let resolvedCount = 0;
            for (const { key, entry } of ordered) {
                if (resolvedCount >= plan.lorebook.maxTotal) break;

                const wName = entry.world || '';
                const uid = String(entry.uid);
                const images = getLorebookImages(wName, uid);
                const enabledImages = images.filter(img => img.enabled !== false);
                if (!enabledImages.length) continue;

                const remaining = plan.lorebook.maxTotal - resolvedCount;
                const toInject = enabledImages.slice(0, remaining);

                // Separate cached vs uncached
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
                    } catch { /* skip batch failures */ }
                }

                const resolvedImages = [];
                for (const img of toInject) {
                    const dataUrl = dataUrlByFilename.get(img.filename);
                    if (dataUrl) {
                        resolvedImages.push({
                            filename: img.filename,
                            dataUrl,
                            label: img.label || '',
                        });
                        resolvedCount++;
                    }
                }

                if (resolvedImages.length > 0) {
                    plan.lorebook.entries.push({ key, entry, images: resolvedImages });
                }
            }
        }
    }

    return plan;
}

/**
 * @typedef {object} SingleSource
 * @property {boolean} enabled
 * @property {string|null} dataUrl
 * @property {string} label
 * @property {string} quality
 * @property {string} position
 * @property {string|null} error
 */

/**
 * @typedef {object} MultiSource
 * @property {boolean} enabled
 * @property {Array<{filename:string, dataUrl:string, label:string}>} images
 * @property {string} quality
 * @property {string} position
 * @property {number} maxCount
 */

/**
 * @typedef {object} LorebookPlan
 * @property {boolean} enabled
 * @property {Array<{key:string, entry:object, images:Array<{filename:string, dataUrl:string, label:string}>}>} entries
 * @property {string} quality
 * @property {string} position
 * @property {number} maxTotal
 */

/**
 * @typedef {object} InjectionPlan
 * @property {SingleSource} char
 * @property {SingleSource} persona
 * @property {MultiSource} extras
 * @property {MultiSource} gallery
 * @property {LorebookPlan} lorebook
 */
