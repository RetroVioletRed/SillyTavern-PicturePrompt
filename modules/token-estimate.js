/**
 * token-estimate.js — Image token estimation for Picture Prompt.
 *
 * Estimates total token cost for all images that will be injected
 * on the next generation. Drives the "≈ N tokens" display in settings.
 *
 * @module token-estimate
 */

import { getContext } from '../../../../extensions.js';
import { characters, this_chid, main_api, user_avatar } from '../../../../../script.js';
import { getImageSizeFromDataURL } from '../../../../utils.js';
import { blobToDataURL, dbGetAll } from './storage.js';
import { getSettings, getSourceQuality, getCharacterAvatarUrl, getPersonaAvatarUrl, getMetaForPersona } from './settings.js';
import { getCharGalleryMeta, getCharGalleryFolder } from './gallery-images.js';
import { getLorebookSettings, getLorebookImages, getLorebookImagesDataUrls, getCached, setCached } from './lorebook-images.js';
import { getActiveEntries } from './lorebook-inject.js';

// ── Constants ─────────────────────────────

const IMAGE_TOKENS_LOW = 85; // OpenAI: low-detail images cost 85 tokens

// ── Module State ──────────────────────────

let _tokenEstimateRunning = false;
let _tokenEstimatePending = false;

// ── Image Token Estimation ────────────────

/**
 * Estimate token cost for a single image.
 * Mirrors openai.js Message.getImageTokenCost().
 */
export async function estimateImageTokens(dataUrl, quality) {
    if (quality === 'low') return IMAGE_TOKENS_LOW;

    try {
        const size = await getImageSizeFromDataURL(dataUrl);
        if (quality === 'auto' && size.width <= 512 && size.height <= 512) {
            return IMAGE_TOKENS_LOW;
        }

        const scale = 2048 / Math.min(size.width, size.height);
        const scaledWidth = Math.round(size.width * scale);
        const scaledHeight = Math.round(size.height * scale);

        const finalScale = 768 / Math.min(scaledWidth, scaledHeight);
        const finalWidth = Math.round(scaledWidth * finalScale);
        const finalHeight = Math.round(scaledHeight * finalScale);

        const squares = Math.ceil(finalWidth / 512) * Math.ceil(finalHeight / 512);
        return squares * 170 + 85;
    } catch {
        return IMAGE_TOKENS_LOW;
    }
}

/**
 * Estimate total tokens for all images that will be injected.
 */
export async function getTotalImageTokenEstimate() {
    const s = getSettings();
    let total = 0;
    let imageCount = 0;
    const sources = [];

    // Character avatar
    if (s.injectChar) {
        const url = getCharacterAvatarUrl();
        if (url) {
            const b64 = await urlToBase64(url);
            if (b64) {
                const q = getSourceQuality(s.qualityCharAvatar);
                total += await estimateImageTokens(b64, q);
                imageCount++;
                sources.push({ name: 'Char', quality: s.qualityCharAvatar, position: s.positionCharAvatar || 'system' });
            }
        }
    }

    // Persona avatar
    if (s.injectPersona) {
        const url = getPersonaAvatarUrl();
        if (url) {
            const b64 = await urlToBase64(url);
            if (b64) {
                const q = getSourceQuality(s.qualityPersonaAvatar);
                total += await estimateImageTokens(b64, q);
                imageCount++;
                sources.push({ name: 'Persona', quality: s.qualityPersonaAvatar, position: s.positionPersonaAvatar || 'system' });
            }
        }
    }

    // Persona extra images
    if (s.extraImagesEnabled && user_avatar) {
        const extras = await getExtraImagesForInjection(user_avatar);
        const maxCount = Number.isFinite(s.maxExtraImages) ? Math.max(0, s.maxExtraImages) : 8;
        const capped = extras.slice(0, maxCount);
        const q = getSourceQuality(s.qualityExtraImages);
        for (const img of capped) {
            total += await estimateImageTokens(img.dataUrl, q);
            imageCount++;
        }
        if (capped.length) sources.push({ name: 'Extras', quality: s.qualityExtraImages, position: s.positionExtraImages || 'system' });
    }

    // Character gallery images
    if (s.charExtraImagesEnabled) {
        const chId = Number(this_chid);
        if (chId >= 0 && characters?.[chId]?.avatar) {
            const avatarId = characters[chId].avatar;
            const meta = getCharGalleryMeta(avatarId);
            const enabledFilenames = Object.entries(meta)
                .filter(([, v]) => v.enabled)
                .map(([k]) => k);
            const maxCount = Number.isFinite(s.charExtraImagesMax) ? Math.max(0, s.charExtraImagesMax) : 8;
            const toInject = enabledFilenames.slice(0, maxCount);
            if (toInject.length > 0) {
                const folder = getCharGalleryFolder();
                if (folder) {
                    const q = getSourceQuality(s.qualityGalleryImages);
                    let galleryCount = 0;
                    for (const filename of toInject) {
                        const url = `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
                        const b64 = await urlToBase64(url);
                        if (b64) {
                            total += await estimateImageTokens(b64, q);
                            imageCount++;
                            galleryCount++;
                        }
                    }
                    if (galleryCount) sources.push({ name: 'Gallery', quality: s.qualityGalleryImages, position: s.positionGalleryImages || 'system' });
                }
            }
        }
    }

    // Lorebook images
    if (s.lorebookImagesEnabled) {
        const lbSettings = getLorebookSettings();
        const entries = await getActiveEntries();
        let lbInjected = 0;
        const lbMax = Number.isFinite(lbSettings.lorebookImagesMax) ? Math.max(0, lbSettings.lorebookImagesMax) : 4;
        const q = getSourceQuality(s.qualityLorebookImages);
        for (const [, entry] of entries) {
            if (lbInjected >= lbMax) break;
            const images = getLorebookImages(entry.world || '', String(entry.uid));
            const enabledImages = images.filter(img => img.enabled !== false);
            const wName = entry.world || '';
            const uid = String(entry.uid);

            const toInject = enabledImages.slice(0, lbMax - lbInjected);
            if (!toInject.length) continue;

            const dataUrlByFilename = new Map();
            const uncachedFilenames = [];
            for (const img of toInject) {
                const key = 'lb::' + wName + '::' + uid + '::' + img.filename;
                const hit = getCached(key);
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
                        const key = 'lb::' + wName + '::' + uid + '::' + filename;
                        setCached(key, dataUrl);
                        dataUrlByFilename.set(filename, dataUrl);
                    }
                } catch { /* skip batch failures */ }
            }

            for (const img of toInject) {
                if (lbInjected >= lbMax) break;
                const b64 = dataUrlByFilename.get(img.filename);
                if (!b64) continue;
                try {
                    total += await estimateImageTokens(b64, q);
                    imageCount++;
                    lbInjected++;
                } catch { /* skip individual token estimate failures */ }
            }
        }
        if (lbInjected) sources.push({ name: 'Lorebook', quality: s.qualityLorebookImages, position: s.positionLorebookImages || 'system' });
    }

    return { total, imageCount, sources };
}

// ── UI Display ─────────────────────────────

/** Show 'calculating...' instantly — call BEFORE refreshTokenEstimate(). */
export function showCalculating() {
    const $el = $('#picture_prompt_token_estimate');
    if ($el.length && getSettings().enabled) {
        $el.text('calculating...').css('color', 'var(--text-color-dim)');
    }
}

export async function refreshTokenEstimate() {
    if (_tokenEstimateRunning) {
        _tokenEstimatePending = true;
        return;
    }

    const $el = $('#picture_prompt_token_estimate');
    const $detail = $('#picture_prompt_token_breakdown');
    if (!$el.length) return;

    const s = getSettings();
    if (!s.enabled) {
        $el.text('disabled').css('color', 'var(--text-color-dim)');
        $detail.text('');
        return;
    }

    $el.text('calculating...').css('color', 'var(--text-color-dim)');
    _tokenEstimateRunning = true;

    try {
        const est = await getTotalImageTokenEstimate();

        const $el2 = $('#picture_prompt_token_estimate');
        const $detail2 = $('#picture_prompt_token_breakdown');
        if (!$el2.length) return;

        if (est.imageCount === 0) {
            $el2.text('0 (no images)').css('color', 'var(--text-color-dim)');
            $detail2.text('');
        } else {
            const provider = main_api;
            let contextLabel = '';
            if (provider === 'openai') contextLabel = 'OpenAI';
            else if (provider === 'anthropic') contextLabel = 'Claude · pixel-based';
            else if (provider === 'google') contextLabel = 'Gemini · tiled';
            else contextLabel = 'Native';

            $el2.text(`≈ ${Math.round(est.total)} tokens`).css('color', 'var(--success-color, #4caf50)');
            let detailParts = [`${est.imageCount} image${est.imageCount !== 1 ? 's' : ''} · ${contextLabel}`];
            for (const src of est.sources) {
                const qLabel = src.quality === 'global' ? 'global' : src.quality;
                const posSuffix = src.position === 'user' ? ' · user' : '';
                detailParts.push(`${src.name}: ${qLabel}${posSuffix}`);
            }
            $detail2.text(detailParts.join(' · '));
        }
    } catch (err) {
        console.warn('[Picture Prompt] Token estimate failed:', err);
        const $el3 = $('#picture_prompt_token_estimate');
        const $detail3 = $('#picture_prompt_token_breakdown');
        if ($el3.length) {
            $el3.text('error').css('color', 'var(--error-color, #e55)');
            $detail3.text('');
        }
    } finally {
        _tokenEstimateRunning = false;
        if (_tokenEstimatePending) {
            _tokenEstimatePending = false;
            refreshTokenEstimate();
        }
    }
}

// ── Shared Image Fetching ─────────────────

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

/** Fetch an image URL (for avatars/gallery) and convert to base64. Cached. */
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
        console.warn('[Picture Prompt] Failed to fetch image:', url, err);
        return null;
    }
}
