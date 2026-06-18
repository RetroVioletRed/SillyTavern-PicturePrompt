/**
 * prompt-injection.js — Prompt injection pipeline for Picture Prompt.
 *
 * Handles the CHAT_COMPLETION_PROMPT_READY event: builds an InjectionPlan,
 * then injects character avatar, persona avatar, gallery images, persona
 * extras, and delegates lorebook injection to lorebook-inject.js.
 *
 * All image data comes from the plan — no duplicate fetching.
 *
 * Pure injection routing lives in injection-routing.js (zero ST imports,
 * testable in Node). This file is the thin ST glue layer.
 *
 * @module prompt-injection
 */

import { getContext } from '../../../../extensions.js';
import { characters, this_chid } from '../../../../../script.js';
import { power_user } from '../../../../power-user.js';
import { getSettings, warnOnce, isImageInliningSupported, isGroupChat } from './settings.js';
import { injectLorebookImages } from './lorebook-inject.js';
import { getTotalImageTokenEstimate } from './token-estimate.js';
import { buildInjectionPlan } from './injection-plan.js';
import {
    findMessageTarget,
    ensureContentBlocks,
    getFirstTextBlock,
    getUserTarget,
    applyInjectionPlan,
} from './injection-routing.js';

// Re-export pure helpers for any callers that import from this module
export { findMessageTarget, ensureContentBlocks, getFirstTextBlock, getUserTarget };

// ── ST Glue Layer ─────────────────────────

/**
 * Handle CHAT_COMPLETION_PROMPT_READY — build an InjectionPlan from ST state,
 * apply it to the chat array, emit warnings for errors/group-chat, and return
 * token estimate stats for the post-generation indicator.
 */
export async function onPromptReady(eventData) {
    const s = getSettings();
    if (!s.enabled) return null;
    if (!isImageInliningSupported()) return null;

    const { chat } = eventData;
    if (!chat?.length) return null;

    // ── Build unified plan (all settings resolved, images fetched) ─
    const plan = await buildInjectionPlan();

    // ── Resolve ST state into opts for pure routing ─
    const context = getContext();
    const userName = context.name1 || 'User';
    const charName = context.name2 || 'Character';
    const chId = Number(this_chid);

    // Resolve character search text for system-message targeting
    let charSearchText = '';
    try {
        charSearchText = (characters?.[chId]?.data?.personality || '').trim();
        if (!charSearchText) {
            charSearchText = (characters?.[chId]?.data?.description || '').trim();
        }
    } catch { /* ignore */ }
    charSearchText = charSearchText.replace(/{{user}}/gi, userName).replace(/{{char}}/gi, charName);

    // Resolve persona search text
    let personaSearchText = '';
    try {
        personaSearchText = (power_user?.persona_description || '').trim()
            .replace(/{{user}}/gi, userName)
            .replace(/{{char}}/gi, charName);
    } catch { /* ignore */ }

    // ── Apply the plan to the chat ───────
    await applyInjectionPlan(chat, plan, {
        userName,
        charName,
        charSearchText,
        personaSearchText,
        injectLorebookFn: injectLorebookImages,
    });

    // ── Warnings (plan-level errors + group chat) ─
    if (s.injectChar && isGroupChat()) {
        warnOnce('group-chat', 'Character avatar injection skipped — not available in group chats. Persona and lorebook injection still active.');
    } else if (plan.char && plan.char.error) {
        if (plan.char.error === 'char-missing') {
            warnOnce('char-missing', 'No character avatar set. Set one in the character panel.');
        } else if (plan.char.error === 'char-fetch') {
            warnOnce('char-fetch', 'Failed to load character avatar image');
        }
    }

    if (plan.persona && plan.persona.error) {
        if (plan.persona.error === 'persona-missing') {
            warnOnce('persona-missing', 'No persona avatar set. Set one in the persona panel.');
        } else if (plan.persona.error === 'persona-fetch') {
            warnOnce('persona-fetch', 'Failed to load persona avatar image');
        }
    }

    // ── Return token estimate from plan (no second walk) ─
    return getTotalImageTokenEstimate(plan);
}
