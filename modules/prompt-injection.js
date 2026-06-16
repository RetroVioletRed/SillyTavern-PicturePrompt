/**
 * prompt-injection.js — Prompt injection pipeline for Picture Prompt.
 *
 * Handles the CHAT_COMPLETION_PROMPT_READY event: builds an InjectionPlan,
 * then injects character avatar, persona avatar, gallery images, persona
 * extras, and delegates lorebook injection to lorebook-inject.js.
 *
 * All image data comes from the plan — no duplicate fetching.
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

// ── Message Helpers ───────────────────────

export function findMessageTarget(chat) {
    const system = chat.find(m => m.role === 'system');
    if (system) return system;
    return chat.find(m => m.role === 'user') || null;
}

export function ensureContentBlocks(msg) {
    if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content }];
        return true;
    }
    if (Array.isArray(msg.content)) {
        if (msg.content.length === 0) {
            msg.content.push({ type: 'text', text: '' });
        }
        return true;
    }
    return false;
}

/** Find the first text block in msg.content, or push a new one. */
export function getFirstTextBlock(msg) {
    const block = msg.content.find(b => b.type === 'text');
    if (block) return block;
    const newBlock = { type: 'text', text: '' };
    msg.content.push(newBlock);
    return newBlock;
}

/**
 * Find the last user message in the chat array.
 */
export function getUserTarget(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].role === 'user') return chat[i];
    }
    return null;
}

// ── Main Injection Pipeline ───────────────

/**
 * Handle CHAT_COMPLETION_PROMPT_READY — build an InjectionPlan,
 * inject all enabled images into the chat array's system/user messages,
 * and return token estimate stats for the post-generation indicator.
 */
export async function onPromptReady(eventData) {
    const s = getSettings();
    if (!s.enabled) return null;
    if (!isImageInliningSupported()) return null;

    const { chat } = eventData;
    if (!chat?.length) return null;

    // ── Build unified plan (all settings resolved, images fetched) ─
    const plan = await buildInjectionPlan();

    const msg = findMessageTarget(chat);
    if (!msg) return null;
    if (!ensureContentBlocks(msg)) return null;

    const context = getContext();
    const userName = context.name1 || 'User';
    const charName = context.name2 || 'Character';

    const chId = Number(this_chid);

    let resolvedPersonaDesc = '';
    try {
        resolvedPersonaDesc = (power_user?.persona_description || '').trim()
            .replace(/{{user}}/gi, userName)
            .replace(/{{char}}/gi, charName);
    } catch {}

    function resolveLabel(template) {
        return (template || '').trim()
            .replace(/{{user}}/gi, userName)
            .replace(/{{char}}/gi, charName);
    }

    function getMessageText(m) {
        return Array.isArray(m.content)
            ? m.content.filter(b => b.type === 'text').map(b => b.text).join('')
            : String(m.content);
    }

    function injectImageToMessage(targetMsg, base64Data, label, quality) {
        if (label) targetMsg.content.push({ type: 'text', text: '\n' + label });
        targetMsg.content.push({ type: 'image_url', image_url: { url: base64Data, detail: quality } });
    }

    /** Find the system message containing char card text (personality or description). */
    function findCharCardMessage() {
        let charSearchText = '';
        try {
            charSearchText = (characters?.[chId]?.data?.personality || '').trim();
            if (!charSearchText) {
                charSearchText = (characters?.[chId]?.data?.description || '').trim();
            }
        } catch {}
        charSearchText = charSearchText.replace(/{{user}}/gi, userName).replace(/{{char}}/gi, charName);
        if (!charSearchText) return null;
        return chat.find(m => m.role === 'system' && getMessageText(m).includes(charSearchText));
    }

    /** Find the system message containing persona description text. */
    function findPersonaMessage() {
        if (!resolvedPersonaDesc) return null;
        return chat.find(m => m.role === 'system' && getMessageText(m).includes(resolvedPersonaDesc));
    }

    // ── Character avatar ───────────────────
    if (plan.char.enabled && plan.char.dataUrl) {
        const label = resolveLabel(plan.char.label);
        if (plan.char.position === 'user') {
            const t = getUserTarget(chat) || msg;
            if (ensureContentBlocks(t)) injectImageToMessage(t, plan.char.dataUrl, label, plan.char.quality);
        } else {
            const charMsg = findCharCardMessage();
            if (charMsg && ensureContentBlocks(charMsg)) {
                injectImageToMessage(charMsg, plan.char.dataUrl, label, plan.char.quality);
            } else {
                injectImageToMessage(msg, plan.char.dataUrl, label, plan.char.quality);
            }
        }
    } else if (s.injectChar && isGroupChat()) {
        warnOnce('group-chat', 'Character avatar injection skipped — not available in group chats. Persona and lorebook injection still active.');
    } else if (plan.char.error === 'char-missing') {
        warnOnce('char-missing', 'No character avatar set. Set one in the character panel.');
    } else if (plan.char.error === 'char-fetch') {
        warnOnce('char-fetch', 'Failed to load character avatar image');
    }

    // ── Character gallery extras ───────────
    if (plan.gallery.enabled && plan.gallery.images.length) {
        let galleryTarget;
        if (plan.gallery.position === 'user') {
            galleryTarget = getUserTarget(chat) || msg;
        } else {
            const gMsg = findCharCardMessage();
            galleryTarget = (gMsg && ensureContentBlocks(gMsg)) ? gMsg : msg;
        }
        ensureContentBlocks(galleryTarget);
        for (const img of plan.gallery.images) {
            if (img.label) galleryTarget.content.push({ type: 'text', text: '\n' + img.label });
            galleryTarget.content.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: plan.gallery.quality } });
        }
    }

    // ── Lorebook images ────────────────────
    if (plan.lorebook.enabled) {
        await injectLorebookImages(chat, plan.lorebook, getUserTarget);
    }

    // ── Persona avatar ─────────────────────
    if (plan.persona.enabled && plan.persona.dataUrl) {
        const label = resolveLabel(plan.persona.label);
        if (plan.persona.position === 'user') {
            const t = getUserTarget(chat) || msg;
            if (ensureContentBlocks(t)) injectImageToMessage(t, plan.persona.dataUrl, label, plan.persona.quality);
        } else {
            const personaMsg = findPersonaMessage();
            if (personaMsg && ensureContentBlocks(personaMsg)) {
                injectImageToMessage(personaMsg, plan.persona.dataUrl, label, plan.persona.quality);
            } else {
                injectImageToMessage(msg, plan.persona.dataUrl, label, plan.persona.quality);
            }
        }
    } else if (plan.persona.error === 'persona-missing') {
        warnOnce('persona-missing', 'No persona avatar set. Set one in the persona panel.');
    } else if (plan.persona.error === 'persona-fetch') {
        warnOnce('persona-fetch', 'Failed to load persona avatar image');
    }

    // ── Persona extra images ───────────────
    if (plan.extras.enabled && plan.extras.images.length) {
        let extrasTarget;
        if (plan.extras.position === 'user') {
            extrasTarget = getUserTarget(chat) || msg;
        } else {
            const eMsg = findPersonaMessage();
            extrasTarget = (eMsg && ensureContentBlocks(eMsg)) ? eMsg : msg;
        }
        ensureContentBlocks(extrasTarget);
        for (const img of plan.extras.images) {
            if (img.label) extrasTarget.content.push({ type: 'text', text: '\n' + img.label });
            extrasTarget.content.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: plan.extras.quality } });
        }
    }

    // ── Return token estimate from plan (no second walk) ─
    return getTotalImageTokenEstimate(plan);
}
