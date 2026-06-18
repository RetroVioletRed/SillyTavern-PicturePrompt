/**
 * injection-routing.js — Pure injection routing functions for Picture Prompt.
 *
 * ZERO SillyTavern imports. All functions accept their dependencies as
 * parameters, making them testable in Node without mocking anything.
 *
 * prompt-injection.js imports from here and adds the ST glue layer.
 *
 * @module injection-routing
 */

// ── Content Block Helpers ──────────────────

/**
 * Extract concatenated text from a message's content blocks.
 * Handles both legacy string content and content-block arrays.
 * @param {object} msg - A chat message object.
 * @returns {string}
 */
export function getMessageText(msg) {
    return Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('')
        : String(msg.content);
}

/**
 * Ensure a message has content in content-block array form.
 * Converts string content to [{ type: 'text', text: ... }].
 * Returns false if content is neither string nor array.
 * @param {object} msg - A chat message object (mutated in-place).
 * @returns {boolean}
 */
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

/**
 * Find the fallback injection target: first system message, then first user.
 * @param {object[]} chat - Array of chat messages.
 * @returns {object|null}
 */
export function findMessageTarget(chat) {
    const system = chat.find(m => m.role === 'system');
    if (system) return system;
    return chat.find(m => m.role === 'user') || null;
}

/**
 * Find the last user message in the chat array.
 * @param {object[]} chat - Array of chat messages.
 * @returns {object|null}
 */
export function getUserTarget(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].role === 'user') return chat[i];
    }
    return null;
}

/**
 * Find the first system message whose text content contains `searchText`.
 * @param {object[]} chat - Array of chat messages.
 * @param {string} searchText - Text to search for (case-sensitive).
 * @returns {object|null}
 */
export function findSystemMessageContaining(chat, searchText) {
    if (!searchText) return null;
    return chat.find(m => m.role === 'system' && getMessageText(m).includes(searchText)) ?? null;
}

// ── Label + Injection Helpers ─────────────

/**
 * Replace {{user}} and {{char}} placeholders in a label template.
 * @param {string} template - Label text with optional placeholders.
 * @param {string} userName - Name to substitute for {{user}}.
 * @param {string} charName - Name to substitute for {{char}}.
 * @returns {string}
 */
export function resolveLabel(template, userName, charName) {
    return (template || '').trim()
        .replace(/{{user}}/gi, userName)
        .replace(/{{char}}/gi, charName);
}

/**
 * Inject one image into a target message: optional label text block,
 * then an image_url content block with the specified quality detail.
 * @param {object} targetMsg - Message object (mutated).
 * @param {string} base64Data - Base64 data URL of the image.
 * @param {string} label - Text label to inject before the image (empty = skip).
 * @param {string} quality - Image detail level ('low' | 'high' | 'auto').
 */
export function injectImageToMessage(targetMsg, base64Data, label, quality) {
    if (label) {
        targetMsg.content.push({ type: 'text', text: '\n' + label });
    }
    targetMsg.content.push({
        type: 'image_url',
        image_url: { url: base64Data, detail: quality },
    });
}

// ── Injection Orchestrator ─────────────────

/**
 * Apply a complete InjectionPlan to a chat array, routing images to the
 * correct system/user messages based on position settings in the plan.
 *
 * Pure function — no ST globals. All dependencies are parameters.
 *
 * @param {object[]} chat - Array of chat messages (mutated in-place).
 * @param {object} plan - InjectionPlan from buildInjectionPlan().
 * @param {object} [opts] - Options.
 * @param {string} [opts.userName='User'] - User's display name.
 * @param {string} [opts.charName='Character'] - Character's display name.
 * @param {string} [opts.charSearchText=''] - Character card text to search
 *   for in system messages (personality or description). Used for system-position
 *   char/gallery routing. If empty, char sources fall back to the main target.
 * @param {string} [opts.personaSearchText=''] - Persona description text to
 *   search for in system messages. Used for system-position persona/extras routing.
 * @param {Function} [opts.injectLorebookFn=null] - Async function
 *   (chat, lorebookPlan, getUserTarget) => void, for lorebook image injection.
 *   If null and lorebook.enabled, lorebook is silently skipped.
 * @returns {object} The chat array (same reference, mutated).
 */
export async function applyInjectionPlan(chat, plan, opts = {}) {
    const {
        userName = 'User',
        charName = 'Character',
        charSearchText = '',
        personaSearchText = '',
        injectLorebookFn = null,
    } = opts;

    if (!Array.isArray(chat) || !chat.length) return chat;
    if (!plan || typeof plan !== 'object') return chat;

    // Fallback target — used when a specific system message can't be found
    const fallbackMsg = findMessageTarget(chat);
    if (!fallbackMsg) return chat;
    ensureContentBlocks(fallbackMsg);

    // ── Character avatar ───────────────────
    if (plan.char && plan.char.enabled && plan.char.dataUrl) {
        const label = resolveLabel(plan.char.label, userName, charName);
        if (plan.char.position === 'user') {
            const t = getUserTarget(chat) || fallbackMsg;
            if (ensureContentBlocks(t)) {
                injectImageToMessage(t, plan.char.dataUrl, label, plan.char.quality);
            }
        } else {
            const charMsg = findSystemMessageContaining(chat, charSearchText);
            if (charMsg && ensureContentBlocks(charMsg)) {
                injectImageToMessage(charMsg, plan.char.dataUrl, label, plan.char.quality);
            } else {
                injectImageToMessage(fallbackMsg, plan.char.dataUrl, label, plan.char.quality);
            }
        }
    }

    // ── Character gallery extras ───────────
    if (plan.gallery && plan.gallery.enabled && plan.gallery.images.length) {
        let galleryTarget;
        if (plan.gallery.position === 'user') {
            galleryTarget = getUserTarget(chat) || fallbackMsg;
        } else {
            const gMsg = findSystemMessageContaining(chat, charSearchText);
            galleryTarget = (gMsg && ensureContentBlocks(gMsg)) ? gMsg : fallbackMsg;
        }
        ensureContentBlocks(galleryTarget);
        for (const img of plan.gallery.images) {
            if (img.label) {
                galleryTarget.content.push({ type: 'text', text: '\n' + img.label });
            }
            galleryTarget.content.push({
                type: 'image_url',
                image_url: { url: img.dataUrl, detail: plan.gallery.quality },
            });
        }
    }

    // ── Lorebook images (delegated) ────────
    if (plan.lorebook && plan.lorebook.enabled && injectLorebookFn) {
        await injectLorebookFn(chat, plan.lorebook, getUserTarget);
    }

    // ── Persona avatar ─────────────────────
    if (plan.persona && plan.persona.enabled && plan.persona.dataUrl) {
        const label = resolveLabel(plan.persona.label, userName, charName);
        if (plan.persona.position === 'user') {
            const t = getUserTarget(chat) || fallbackMsg;
            if (ensureContentBlocks(t)) {
                injectImageToMessage(t, plan.persona.dataUrl, label, plan.persona.quality);
            }
        } else {
            const personaMsg = findSystemMessageContaining(chat, personaSearchText);
            if (personaMsg && ensureContentBlocks(personaMsg)) {
                injectImageToMessage(personaMsg, plan.persona.dataUrl, label, plan.persona.quality);
            } else {
                injectImageToMessage(fallbackMsg, plan.persona.dataUrl, label, plan.persona.quality);
            }
        }
    }

    // ── Persona extra images ───────────────
    if (plan.extras && plan.extras.enabled && plan.extras.images.length) {
        let extrasTarget;
        if (plan.extras.position === 'user') {
            extrasTarget = getUserTarget(chat) || fallbackMsg;
        } else {
            const eMsg = findSystemMessageContaining(chat, personaSearchText);
            extrasTarget = (eMsg && ensureContentBlocks(eMsg)) ? eMsg : fallbackMsg;
        }
        ensureContentBlocks(extrasTarget);
        for (const img of plan.extras.images) {
            if (img.label) {
                extrasTarget.content.push({ type: 'text', text: '\n' + img.label });
            }
            extrasTarget.content.push({
                type: 'image_url',
                image_url: { url: img.dataUrl, detail: plan.extras.quality },
            });
        }
    }

    return chat;
}
