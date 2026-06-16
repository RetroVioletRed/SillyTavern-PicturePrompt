/**
 * prompt-injection.js — Prompt injection pipeline for Picture Prompt.
 *
 * Handles the CHAT_COMPLETION_PROMPT_READY event: injects character avatar,
 * persona avatar, gallery images, persona extras, and delegates lorebook
 * injection to lorebook-inject.js.
 *
 * @module prompt-injection
 */

import { getContext } from '../../../../extensions.js';
import { characters, this_chid, user_avatar } from '../../../../../script.js';
import { power_user } from '../../../../power-user.js';
import { getSettings, warnOnce, isImageInliningSupported, isGroupChat, getSourceQuality, getCharacterAvatarUrl, getPersonaAvatarUrl } from './settings.js';
import { getCharGalleryMeta, getCharGalleryFolder } from './gallery-images.js';
import { getLorebookSettings } from './lorebook-images.js';
import { injectLorebookImages } from './lorebook-inject.js';
import { getExtraImagesForInjection, urlToBase64, getTotalImageTokenEstimate } from './token-estimate.js';

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
 * Handle CHAT_COMPLETION_PROMPT_READY — inject all enabled images
 * into the chat array's system/user messages.
 *
 * Returns injection stats { total, imageCount, sources } so the
 * orchestrator can surface them (e.g. post-generation indicator).
 */
export async function onPromptReady(eventData) {
    const s = getSettings();
    if (!s.enabled) return null;
    if (!isImageInliningSupported()) return null;

    const { chat } = eventData;
    if (!chat?.length) return null;

    const lbSettings = getLorebookSettings();

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

    // ── Character avatar ──
    if (s.injectChar && !isGroupChat()) {
        const charPosition = s.positionCharAvatar || 'system';
        const url = getCharacterAvatarUrl();
        if (url) {
            const base64Data = await urlToBase64(url);
            if (base64Data) {
                const label = resolveLabel(s.labelChar);
                const charQ = getSourceQuality(s.qualityCharAvatar);
                if (charPosition === 'user') {
                    const t = getUserTarget(chat) || msg;
                    if (ensureContentBlocks(t)) injectImageToMessage(t, base64Data, label, charQ);
                } else {
                    let charSearchText = '';
                    try {
                        charSearchText = (characters?.[chId]?.data?.personality || '').trim();
                        if (!charSearchText) {
                            charSearchText = (characters?.[chId]?.data?.description || '').trim();
                        }
                    } catch {}
                    charSearchText = charSearchText.replace(/{{user}}/gi, userName).replace(/{{char}}/gi, charName);
                    const charMsg = charSearchText
                        ? chat.find(m => m.role === 'system' && getMessageText(m).includes(charSearchText))
                        : null;
                    if (charMsg && ensureContentBlocks(charMsg)) {
                        injectImageToMessage(charMsg, base64Data, label, charQ);
                    } else {
                        injectImageToMessage(msg, base64Data, label, charQ);
                    }
                }
            } else {
                warnOnce('char-fetch', 'Failed to load character avatar image');
            }
        } else {
            warnOnce('char-missing', 'No character avatar set. Set one in the character panel.');
        }
    } else if (s.injectChar && isGroupChat()) {
        warnOnce('group-chat', 'Character avatar injection skipped — not available in group chats. Persona and lorebook injection still active.');
    }

    // ── Character gallery extras ──
    if (s.charExtraImagesEnabled && !isGroupChat()) {
        const galleryPosition = s.positionGalleryImages || 'system';
        let galleryTarget;
        if (galleryPosition === 'user') {
            galleryTarget = getUserTarget(chat) || msg;
        } else {
            let charSearchText = '';
            try {
                charSearchText = (characters?.[chId]?.data?.personality || '').trim();
                if (!charSearchText) {
                    charSearchText = (characters?.[chId]?.data?.description || '').trim();
                }
            } catch {}
            charSearchText = charSearchText.replace(/{{user}}/gi, userName).replace(/{{char}}/gi, charName);
            const gMsg = charSearchText
                ? chat.find(m => m.role === 'system' && getMessageText(m).includes(charSearchText))
                : null;
            galleryTarget = (gMsg && ensureContentBlocks(gMsg)) ? gMsg : msg;
        }
        ensureContentBlocks(galleryTarget);
        await injectCharGalleryImages(galleryTarget, getSourceQuality(s.qualityGalleryImages), s.charExtraImagesMax);
    }

    // ── Lorebook images ──
    if (s.lorebookImagesEnabled) {
        await injectLorebookImages(chat, getSourceQuality(s.qualityLorebookImages), {
            ...lbSettings,
            positionLorebookImages: s.positionLorebookImages || 'system',
        }, getUserTarget);
    }

    // ── Persona avatar ──
    if (s.injectPersona) {
        const personaPosition = s.positionPersonaAvatar || 'system';
        const url = getPersonaAvatarUrl();
        if (url) {
            const base64Data = await urlToBase64(url);
            if (base64Data) {
                const label = resolveLabel(s.labelUser);
                const personaQ = getSourceQuality(s.qualityPersonaAvatar);
                if (personaPosition === 'user') {
                    const t = getUserTarget(chat) || msg;
                    if (ensureContentBlocks(t)) injectImageToMessage(t, base64Data, label, personaQ);
                } else {
                    const personaMsg = resolvedPersonaDesc
                        ? chat.find(m => m.role === 'system' && getMessageText(m).includes(resolvedPersonaDesc))
                        : null;
                    if (personaMsg && ensureContentBlocks(personaMsg)) {
                        injectImageToMessage(personaMsg, base64Data, label, personaQ);
                    } else {
                        injectImageToMessage(msg, base64Data, label, personaQ);
                    }
                }
            } else {
                warnOnce('persona-fetch', 'Failed to load persona avatar image');
            }
        } else {
            warnOnce('persona-missing', 'No persona avatar set. Set one in the persona panel.');
        }
    }

    // ── Persona extra images ──
    if (s.extraImagesEnabled && user_avatar) {
        const extrasPosition = s.positionExtraImages || 'system';
        let extrasTarget;
        if (extrasPosition === 'user') {
            extrasTarget = getUserTarget(chat) || msg;
        } else {
            const eMsg = resolvedPersonaDesc
                ? chat.find(m => m.role === 'system' && getMessageText(m).includes(resolvedPersonaDesc))
                : null;
            extrasTarget = (eMsg && ensureContentBlocks(eMsg)) ? eMsg : msg;
        }
        ensureContentBlocks(extrasTarget);
        if (extrasTarget) {
            const extras = await getExtraImagesForInjection(user_avatar);
            const maxCount = Number.isFinite(s.maxExtraImages) ? Math.max(0, s.maxExtraImages) : 8;
            const capped = extras.slice(0, maxCount);
            for (const img of capped) {
                const perImageLabel = (img.label || '').trim();
                if (perImageLabel) {
                    extrasTarget.content.push({ type: 'text', text: '\n' + perImageLabel });
                }
                extrasTarget.content.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: getSourceQuality(s.qualityExtraImages) } });
            }
        }
    }

    return getTotalImageTokenEstimate();
}

// ── Gallery Image Injection ───────────────

/**
 * Fetch enabled character gallery images and inject them into the prompt.
 */
export async function injectCharGalleryImages(msg, quality, maxCount) {
    if (isGroupChat()) return;
    const chId = Number(this_chid);
    if (!characters?.[chId]?.avatar) return;

    const avatarId = characters[chId].avatar;
    const meta = getCharGalleryMeta(avatarId);
    const enabledFilenames = Object.entries(meta)
        .filter(([, v]) => v.enabled)
        .map(([k]) => k);

    if (!enabledFilenames.length) return;

    const folder = getCharGalleryFolder();
    if (!folder) return;

    const effectiveMax = Number.isFinite(maxCount) ? Math.max(0, maxCount) : 8;
    const toInject = enabledFilenames.slice(0, effectiveMax);

    for (const filename of toInject) {
        const url = `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
        const base64Data = await urlToBase64(url);
        if (base64Data) {
            const label = (meta[filename]?.label || '').trim();
            if (label) {
                msg.content.push({ type: 'text', text: '\n' + label });
            }
            msg.content.push({ type: 'image_url', image_url: { url: base64Data, detail: quality } });
        } else {
            console.debug('[Picture Prompt] Gallery image not found (may have been deleted):', filename);
        }
    }
}
