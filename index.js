import {
    eventSource,
    event_types,
} from '../../../events.js';
import {
    getContext,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import {
    getThumbnailUrl,
    characters,
    this_chid,
    main_api,
    user_avatar,
} from '../../../../script.js';
import { oai_settings } from '../../../openai.js';

// ── Vision Check ───────────────────────────────────────────────────

/**
 * @returns {boolean} Whether the current model + settings support image inlining
 */
function isImageInliningSupported() {
    if (main_api !== 'openai') return false;
    if (!oai_settings?.media_inlining) return false;
    return true;
}

// ── Avatar Fetching ────────────────────────────────────────────────

/**
 * @returns {string|null} Current character's avatar thumbnail URL
 */
function getCharacterAvatarUrl() {
    const chId = Number(this_chid);
    if (chId < 0 || !characters?.[chId]?.avatar) return null;
    return getThumbnailUrl('avatar', characters[chId].avatar);
}

/**
 * @returns {string|null} Current user persona's avatar thumbnail URL
 */
function getPersonaAvatarUrl() {
    if (!user_avatar) return null;
    return getThumbnailUrl('persona', user_avatar);
}

// ── Settings ───────────────────────────────────────────────────────

const moduleName = 'avatar_inject';

const defaultSettings = {
    enabled: true,
    injectTarget: 'character',  // 'character' | 'persona' | 'both'
    imageQuality: 'auto',       // 'low' | 'high' | 'auto'
    labelChar: 'This is how you look:',
    labelUser: 'This is how {{user}} looks:',
};

function getSettings() {
    const context = getContext();
    if (!context.extensionSettings[moduleName]) {
        context.extensionSettings[moduleName] = { ...defaultSettings };
    }
    const s = context.extensionSettings[moduleName];
    for (const key of Object.keys(defaultSettings)) {
        if (s[key] === undefined) s[key] = defaultSettings[key];
    }
    return s;
}

function applySettingsToUI() {
    const s = getSettings();
    $('#avatar_inject_enabled').prop('checked', s.enabled);
    $('#avatar_inject_target').val(s.injectTarget);
    $('#avatar_inject_quality').val(s.imageQuality);
    $('#avatar_inject_label_char').val(s.labelChar || '');
    $('#avatar_inject_label_user').val(s.labelUser || '');
}

function registerSettingsListeners() {
    $('#avatar_inject_enabled').on('change', function () {
        const s = getSettings();
        s.enabled = !!$(this).prop('checked');
        getContext().saveSettingsDebounced();
    });
    $('#avatar_inject_target').on('change', function () {
        getSettings().injectTarget = String($(this).val());
        getContext().saveSettingsDebounced();
    });
    $('#avatar_inject_quality').on('change', function () {
        getSettings().imageQuality = String($(this).val());
        getContext().saveSettingsDebounced();
    });
    $('#avatar_inject_label_char').on('input', function () {
        getSettings().labelChar = String($(this).val());
        getContext().saveSettingsDebounced();
    });
    $('#avatar_inject_label_user').on('input', function () {
        getSettings().labelUser = String($(this).val());
        getContext().saveSettingsDebounced();
    });
}

// ── Prompt Injection ───────────────────────────────────────────────

async function urlToBase64(url) {
    try {
        const response = await fetch(url, { method: 'GET', cache: 'force-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (err) {
        console.warn('[Avatar Inject] Failed to fetch image:', url, err);
        return null;
    }
}

/**
 * Fired when the chat completion prompt is fully assembled.
 * Injects avatar images into the first user message (system prompts
 * can serialize base64 as raw text on some providers).
 */
async function onPromptReady(eventData) {
    const s = getSettings();
    if (!s.enabled) return;
    if (!isImageInliningSupported()) return;

    const { chat } = eventData;
    if (!chat?.length) return;

    // Find the first user message — injecting into a system prompt can
    // cause the base64 string to be sent as raw text rather than an image.
    const msg = chat.find(m => m.role === 'user') || chat[0];

    // Ensure content is an array of content blocks
    if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content }];
    } else if (!Array.isArray(msg.content)) {
        console.debug('[Avatar Inject] Unexpected content type, skipping');
        return;
    }

    const quality = oai_settings?.inline_image_quality || 'auto';

    const context = getContext();
    const userName = context.name1 || 'User';
    const charName = context.name2 || 'Character';

    function resolveLabel(template) {
        return (template || '').trim()
            .replace(/\{\{user\}\}/gi, userName)
            .replace(/\{\{char\}\}/gi, charName);
    }

    // Inject character avatar
    if (s.injectTarget === 'character' || s.injectTarget === 'both') {
        const url = getCharacterAvatarUrl();
        if (url) {
            console.debug('[Avatar Inject] Fetching character avatar:', url);
            const base64Data = await urlToBase64(url);
            if (base64Data) {
                const label = resolveLabel(s.labelChar);
                // Merge label into the existing text block instead of creating a separate one
                if (label) msg.content[0].text += '\n' + label;
                msg.content.push({
                    type: 'image_url',
                    image_url: { url: base64Data, detail: quality },
                });
                console.debug('[Avatar Inject] Injected character avatar');
            }
        }
    }

    // Inject user persona avatar
    if (s.injectTarget === 'persona' || s.injectTarget === 'both') {
        const url = getPersonaAvatarUrl();
        if (url) {
            console.debug('[Avatar Inject] Fetching user avatar:', url);
            const base64Data = await urlToBase64(url);
            if (base64Data) {
                const label = resolveLabel(s.labelUser);
                // Merge label into the existing text block instead of creating a separate one
                if (label) msg.content[0].text += '\n' + label;
                msg.content.push({
                    type: 'image_url',
                    image_url: { url: base64Data, detail: quality },
                });
                console.debug('[Avatar Inject] Injected user avatar');
            }
        }
    }
}

// ── Init ───────────────────────────────────────────────────────────

async function addSettingsUI() {
    const html = await renderExtensionTemplateAsync('third-party/avatar-inject', 'settings');
    $('#extensions_settings').append(html);
    applySettingsToUI();
    registerSettingsListeners();
}

export async function activate() {
    getSettings();
    await addSettingsUI();
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    console.debug('[Avatar Inject] Activated');
}
