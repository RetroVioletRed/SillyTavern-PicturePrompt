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

const moduleName = 'picture_prompt';

const defaultSettings = {
    enabled: true,
    injectTarget: 'character',  // 'character' | 'persona' | 'both'
    imageQuality: 'auto',       // 'low' | 'high' | 'auto'
    labelChar: 'This is how you look:',
    labelUser: 'This is how {{user}} looks:',
};

/**
 * Migrate settings from the old module name (avatar_inject) to the new one.
 * Reads old settings, merges into defaults, saves under the new key, then
 * clears the old key so the migration runs only once.
 */
function migrateOldSettings() {
    const context = getContext();
    const old = context.extensionSettings?.['avatar_inject'];
    if (!old) return; // nothing to migrate

    console.debug('[Picture Prompt] Migrating settings from avatar_inject');

    const migrated = { ...defaultSettings };
    for (const key of Object.keys(defaultSettings)) {
        if (old[key] !== undefined) migrated[key] = old[key];
    }

    context.extensionSettings[moduleName] = migrated;
    delete context.extensionSettings['avatar_inject'];
    context.saveSettingsDebounced();
}

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
    $('#picture_prompt_enabled').prop('checked', s.enabled);
    $('#picture_prompt_target').val(s.injectTarget);
    $('#picture_prompt_quality').val(s.imageQuality);
    $('#picture_prompt_label_char').val(s.labelChar || '');
    $('#picture_prompt_label_user').val(s.labelUser || '');
}

function registerSettingsListeners() {
    $('#picture_prompt_enabled').on('change', function () {
        const s = getSettings();
        s.enabled = !!$(this).prop('checked');
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_target').on('change', function () {
        getSettings().injectTarget = String($(this).val());
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_quality').on('change', function () {
        getSettings().imageQuality = String($(this).val());
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_label_char').on('input', function () {
        getSettings().labelChar = String($(this).val());
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_label_user').on('input', function () {
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
        console.warn('[Picture Prompt] Failed to fetch image:', url, err);
        return null;
    }
}

/**
 * Find the system message in the chat array. System messages are already
 * squashed by the time CHAT_COMPLETION_PROMPT_READY fires, so there's
 * usually just one. Falls back to the first user message if no system
 * message exists (e.g. models that don't use system prompts).
 */
function findMessageTarget(chat) {
    const system = chat.find(m => m.role === 'system');
    if (system) return system;
    return chat.find(m => m.role === 'user') || chat[0];
}

/**
 * Ensure a message's content is an array of content blocks.
 * Converts string content to [{ type: 'text', text }] format.
 * Returns false if the content type is unexpected.
 */
function ensureContentBlocks(msg) {
    if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content }];
        return true;
    }
    if (Array.isArray(msg.content)) return true;
    console.debug('[Picture Prompt] Unexpected content type, skipping');
    return false;
}

/**
 * Fired when the chat completion prompt is fully assembled.
 * Injects avatar images into the system prompt (or first user message
 * as fallback) so the model has a visual reference for characters.
 */
async function onPromptReady(eventData) {
    const s = getSettings();
    if (!s.enabled) return;
    if (!isImageInliningSupported()) return;

    const { chat } = eventData;
    if (!chat?.length) return;

    // Target the system prompt — it's the right place for visual context
    const msg = findMessageTarget(chat);
    if (!ensureContentBlocks(msg)) return;

    const quality = oai_settings?.inline_image_quality || 'auto';

    const context = getContext();
    const userName = context.name1 || 'User';
    const charName = context.name2 || 'Character';

    function resolveLabel(template) {
        return (template || '').trim()
            .replace(/{{user}}/gi, userName)
            .replace(/{{char}}/gi, charName);
    }

    // Inject character avatar
    if (s.injectTarget === 'character' || s.injectTarget === 'both') {
        const url = getCharacterAvatarUrl();
        if (url) {
            console.debug('[Picture Prompt] Fetching character avatar:', url);
            const base64Data = await urlToBase64(url);
            if (base64Data) {
                const label = resolveLabel(s.labelChar);
                if (label) msg.content[0].text += '\n' + label;
                msg.content.push({
                    type: 'image_url',
                    image_url: { url: base64Data, detail: quality },
                });
                console.debug('[Picture Prompt] Injected character avatar');
            }
        }
    }

    // Inject user persona avatar
    if (s.injectTarget === 'persona' || s.injectTarget === 'both') {
        const url = getPersonaAvatarUrl();
        if (url) {
            console.debug('[Picture Prompt] Fetching user avatar:', url);
            const base64Data = await urlToBase64(url);
            if (base64Data) {
                const label = resolveLabel(s.labelUser);
                if (label) msg.content[0].text += '\n' + label;
                msg.content.push({
                    type: 'image_url',
                    image_url: { url: base64Data, detail: quality },
                });
                console.debug('[Picture Prompt] Injected user avatar');
            }
        }
    }
}

// ── Init ───────────────────────────────────────────────────────────

async function addSettingsUI() {
    const html = await renderExtensionTemplateAsync('third-party/picture-prompt', 'settings');
    $('#extensions_settings').append(html);
    migrateOldSettings();
    applySettingsToUI();
    registerSettingsListeners();
}

export async function activate() {
    getSettings();
    await addSettingsUI();
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    console.debug('[Picture Prompt] Activated');
}
