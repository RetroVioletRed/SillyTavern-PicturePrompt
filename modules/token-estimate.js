/**
 * token-estimate.js — Image token estimation for Picture Prompt.
 *
 * Estimates total token cost for all images that will be injected
 * on the next generation. Drives the "≈ N tokens" display in settings.
 *
 * Reads from InjectionPlan (built by injection-plan.js) — no duplicate
 * settings resolution or image fetching.
 *
 * @module token-estimate
 */

import { main_api } from '../../../../../script.js';
import { getImageSizeFromDataURL } from '../../../../utils.js';
import { getSettings } from './settings.js';
import { log } from './storage.js';
import { buildInjectionPlan } from './injection-plan.js';

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
 * Estimate total tokens from a pre-built InjectionPlan.
 * Returns { total, imageCount, sources } for the UI and post-generation indicator.
 */
export async function getTotalImageTokenEstimate(plan) {
    let total = 0;
    let imageCount = 0;
    const sources = [];

    // Character avatar
    if (plan.char.enabled && plan.char.dataUrl) {
        total += await estimateImageTokens(plan.char.dataUrl, plan.char.quality);
        imageCount++;
        sources.push({ name: 'Char', quality: plan.char.quality, position: plan.char.position });
    }

    // Persona avatar
    if (plan.persona.enabled && plan.persona.dataUrl) {
        total += await estimateImageTokens(plan.persona.dataUrl, plan.persona.quality);
        imageCount++;
        sources.push({ name: 'Persona', quality: plan.persona.quality, position: plan.persona.position });
    }

    // Persona extra images
    if (plan.extras.enabled && plan.extras.images.length) {
        for (const img of plan.extras.images) {
            total += await estimateImageTokens(img.dataUrl, plan.extras.quality);
            imageCount++;
        }
        sources.push({ name: 'Extras', quality: plan.extras.quality, position: plan.extras.position });
    }

    // Character gallery images
    if (plan.gallery.enabled && plan.gallery.images.length) {
        for (const img of plan.gallery.images) {
            total += await estimateImageTokens(img.dataUrl, plan.gallery.quality);
            imageCount++;
        }
        sources.push({ name: 'Gallery', quality: plan.gallery.quality, position: plan.gallery.position });
    }

    // Lorebook images
    if (plan.lorebook.enabled && plan.lorebook.entries.length) {
        let lbCount = 0;
        for (const { images } of plan.lorebook.entries) {
            for (const img of images) {
                try {
                    total += await estimateImageTokens(img.dataUrl, plan.lorebook.quality);
                    imageCount++;
                    lbCount++;
                } catch { /* skip individual token estimate failures */ }
            }
        }
        if (lbCount) sources.push({ name: 'Lorebook', quality: plan.lorebook.quality, position: plan.lorebook.position });
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
        const plan = await buildInjectionPlan();
        const est = await getTotalImageTokenEstimate(plan);

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
        log.warn('Token estimate failed:', err);
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
