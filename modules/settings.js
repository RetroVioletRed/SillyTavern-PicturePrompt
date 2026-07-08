/**
 * settings.js — Settings, metadata, and shared utility functions
 * for the Picture Prompt extension.
 *
 * @module settings
 */

import {
    getContext,
    renderExtensionTemplateAsync,
} from '../../../../extensions.js';
import {
    getThumbnailUrl,
    characters,
    this_chid,
    main_api,
    user_avatar,
} from '../../../../../script.js';
import { oai_settings, isImageInliningSupported as stImageInliningSupported } from '../../../../openai.js';
import { dbGetAll, log } from './storage.js';

// ── Module Constants ──────────────────────

export const moduleName = 'picture_prompt';

export const defaultSettings = {
    enabled: true,
    injectChar: true,
    injectPersona: false,
    labelChar: 'This is how you look:',
    labelUser: 'This is how {{user}} looks:',
    extraImagesEnabled: true,
    maxExtraImages: 8,
    charExtraImagesEnabled: false,
    charExtraImagesMax: 8,
    lorebookImagesEnabled: false,
    lorebookImagesMax: 4,
    qualityCharAvatar: 'global',
    qualityPersonaAvatar: 'global',
    qualityExtraImages: 'global',
    qualityGalleryImages: 'global',
    qualityLorebookImages: 'global',
    positionCharAvatar: 'system',
    positionPersonaAvatar: 'system',
    positionExtraImages: 'system',
    positionGalleryImages: 'system',
    positionLorebookImages: 'system',
    injectionIndicatorEnabled: true,
    preprocessMaxDimension: 2048,
    preprocessConvertWebp: false,
    preprocessWebpQuality: 80,
};

// ── User Feedback ─────────────────────────

let _shownErrors = {};

export function warnOnce(key, message) {
    if (_shownErrors[key]) return;
    _shownErrors[key] = true;
    toastr.warning(message, 'Picture Prompt');
}

// ── Vision Check ──────────────────────────

export function isImageInliningSupported() {
    const supported = stImageInliningSupported();
    if (!supported) {
        warnOnce('api', 'Picture Prompt cannot inject images — the current API/model does not support inline media, or media inlining is disabled in AI Response settings.');
    }
    return supported;
}

// ── Avatar / Chat Helpers ─────────────────

export function isGroupChat() {
    const chId = Number(this_chid);
    return !Number.isFinite(chId) || chId < 0;
}

/**
 * Resolve a per-source quality override. Returns the global
 * inline_image_quality when the source setting is 'global'.
 */
export function getSourceQuality(sourceSetting) {
    if (!sourceSetting || sourceSetting === 'global') {
        return oai_settings?.inline_image_quality || 'auto';
    }
    return sourceSetting;
}

export function getCharacterAvatarUrl() {
    if (isGroupChat()) return null;
    const chId = Number(this_chid);
    if (!characters?.[chId]?.avatar) return null;
    return getThumbnailUrl('avatar', characters[chId].avatar);
}

export function getPersonaAvatarUrl() {
    if (!user_avatar) return null;
    return getThumbnailUrl('persona', user_avatar);
}

// ── Core Settings ─────────────────────────

export function migrateOldSettings() {
    const context = getContext();
    const old = context.extensionSettings?.['avatar_inject'];
    if (!old) return;

    log.debug('Migrating settings from avatar_inject');
    const migrated = { ...defaultSettings };
    for (const key of Object.keys(defaultSettings)) {
        if (old[key] !== undefined) migrated[key] = old[key];
    }
    context.extensionSettings[moduleName] = migrated;
    delete context.extensionSettings['avatar_inject'];
    context.saveSettingsDebounced();
}

export function getSettings() {
    const context = getContext();
    if (!context.extensionSettings[moduleName]) {
        context.extensionSettings[moduleName] = { ...defaultSettings };
    }
    const s = context.extensionSettings[moduleName];
    for (const key of Object.keys(defaultSettings)) {
        if (s[key] === undefined) s[key] = defaultSettings[key];
    }
    // Migrate pre-v1.5 injectTarget to injectChar/injectPersona
    if (s.injectTarget !== undefined) {
        s.injectChar = s.injectChar ?? (s.injectTarget === 'character' || s.injectTarget === 'both');
        s.injectPersona = s.injectPersona ?? (s.injectTarget === 'persona' || s.injectTarget === 'both');
        delete s.injectTarget;
        context.saveSettingsDebounced();
    }
    return s;
}

export function applySettingsToUI() {
    const s = getSettings();
    $('#picture_prompt_enabled').prop('checked', s.enabled);
    $('#picture_prompt_inject_char').prop('checked', s.injectChar);
    $('#picture_prompt_inject_persona').prop('checked', s.injectPersona);
    $('#picture_prompt_label_char').val(s.labelChar || '');
    $('#picture_prompt_label_user').val(s.labelUser || '');
    $('#pp_char_label_row').toggle(s.injectChar);
    $('#pp_persona_label_row').toggle(s.injectPersona);
    $('#pp_extras_controls').toggle(s.extraImagesEnabled ?? true);
    $('#pp_gallery_controls').toggle(s.charExtraImagesEnabled ?? false);
    $('#pp_lorebook_controls').toggle(s.lorebookImagesEnabled ?? false);
    $('#picture_prompt_quality_char_avatar').toggle(s.injectChar);
    $('#picture_prompt_quality_persona_avatar').toggle(s.injectPersona);
    $('#picture_prompt_extra_images_enabled').prop('checked', s.extraImagesEnabled ?? true);
    $('#picture_prompt_extra_images_max').val(s.maxExtraImages ?? 8);
    $('#picture_prompt_char_extra_enabled').prop('checked', s.charExtraImagesEnabled ?? false);
    $('#picture_prompt_char_extra_max').val(s.charExtraImagesMax ?? 8);
    $('#picture_prompt_lorebook_enabled').prop('checked', s.lorebookImagesEnabled ?? false);
    $('#picture_prompt_lorebook_max').val(s.lorebookImagesMax ?? 4);
    $('#picture_prompt_quality_char_avatar').val(s.qualityCharAvatar ?? 'global');
    $('#picture_prompt_quality_persona_avatar').val(s.qualityPersonaAvatar ?? 'global');
    $('#picture_prompt_quality_extra_images').val(s.qualityExtraImages ?? 'global');
    $('#picture_prompt_quality_char_extra').val(s.qualityGalleryImages ?? 'global');
    $('#picture_prompt_quality_lorebook').val(s.qualityLorebookImages ?? 'global');
    $('#picture_prompt_position_char_avatar').text(s.positionCharAvatar === 'user' ? 'U' : 'S').toggleClass('pp-position-user', s.positionCharAvatar === 'user');
    $('#picture_prompt_position_persona_avatar').text(s.positionPersonaAvatar === 'user' ? 'U' : 'S').toggleClass('pp-position-user', s.positionPersonaAvatar === 'user');
    $('#picture_prompt_position_extra_images').text(s.positionExtraImages === 'user' ? 'U' : 'S').toggleClass('pp-position-user', s.positionExtraImages === 'user');
    $('#picture_prompt_position_char_extra').text(s.positionGalleryImages === 'user' ? 'U' : 'S').toggleClass('pp-position-user', s.positionGalleryImages === 'user');
    $('#picture_prompt_position_lorebook').text(s.positionLorebookImages === 'user' ? 'U' : 'S').toggleClass('pp-position-user', s.positionLorebookImages === 'user');
    $('#picture_prompt_injection_indicator').prop('checked', s.injectionIndicatorEnabled ?? true);
}

export function registerSettingsListeners() {
    $('#picture_prompt_enabled').on('change', function () {
        getSettings().enabled = !!$(this).prop('checked');
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_inject_char').on('change', function () {
        getSettings().injectChar = !!$(this).prop('checked');
        getContext().saveSettingsDebounced();
        $('#pp_char_label_row').toggle(this.checked);
        $('#picture_prompt_quality_char_avatar').toggle(this.checked);
    });
    $('#picture_prompt_inject_persona').on('change', function () {
        getSettings().injectPersona = !!$(this).prop('checked');
        getContext().saveSettingsDebounced();
        $('#pp_persona_label_row').toggle(this.checked);
        $('#picture_prompt_quality_persona_avatar').toggle(this.checked);
    });
    $('#picture_prompt_label_char').on('input', function () {
        getSettings().labelChar = String($(this).val());
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_label_user').on('input', function () {
        getSettings().labelUser = String($(this).val());
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_extra_images_enabled').on('change', function () {
        getSettings().extraImagesEnabled = !!$(this).prop('checked');
        getContext().saveSettingsDebounced();
        $('#pp_extras_controls').toggle(this.checked);
    });
    $('#picture_prompt_extra_images_max').on('input', function () {
        const n = parseInt($(this).val(), 10);
        getSettings().maxExtraImages = Number.isFinite(n) ? Math.max(0, n) : 8;
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_char_extra_enabled').on('change', function () {
        getSettings().charExtraImagesEnabled = !!$(this).prop('checked');
        getContext().saveSettingsDebounced();
        $('#pp_gallery_controls').toggle(this.checked);
    });
    $('#picture_prompt_char_extra_max').on('input', function () {
        const n = parseInt($(this).val(), 10);
        getSettings().charExtraImagesMax = Number.isFinite(n) ? Math.max(0, n) : 8;
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_lorebook_enabled').on('change', function () {
        getSettings().lorebookImagesEnabled = !!$(this).prop('checked');
        getContext().saveSettingsDebounced();
        $('#pp_lorebook_controls').toggle(this.checked);
    });
    $('#picture_prompt_lorebook_max').on('input', function () {
        const n = parseInt($(this).val(), 10);
        getSettings().lorebookImagesMax = Number.isFinite(n) ? Math.max(0, n) : 4;
        getContext().saveSettingsDebounced();
    });

    // Quality selectors
    $('#picture_prompt_quality_char_avatar').on('change', function () {
        getSettings().qualityCharAvatar = String($(this).val());
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_quality_persona_avatar').on('change', function () {
        getSettings().qualityPersonaAvatar = String($(this).val());
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_quality_extra_images').on('change', function () {
        getSettings().qualityExtraImages = String($(this).val());
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_quality_char_extra').on('change', function () {
        getSettings().qualityGalleryImages = String($(this).val());
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_quality_lorebook').on('change', function () {
        getSettings().qualityLorebookImages = String($(this).val());
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_injection_indicator').on('change', function () {
        getSettings().injectionIndicatorEnabled = !!$(this).prop('checked');
        getContext().saveSettingsDebounced();
    });

    // Position toggle buttons
    $('#picture_prompt_position_char_avatar').on('click', function () {
        const s = getSettings();
        s.positionCharAvatar = s.positionCharAvatar === 'user' ? 'system' : 'user';
        $(this).text(s.positionCharAvatar === 'user' ? 'U' : 'S').toggleClass('pp-position-user', s.positionCharAvatar === 'user');
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_position_persona_avatar').on('click', function () {
        const s = getSettings();
        s.positionPersonaAvatar = s.positionPersonaAvatar === 'user' ? 'system' : 'user';
        $(this).text(s.positionPersonaAvatar === 'user' ? 'U' : 'S').toggleClass('pp-position-user', s.positionPersonaAvatar === 'user');
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_position_extra_images').on('click', function () {
        const s = getSettings();
        s.positionExtraImages = s.positionExtraImages === 'user' ? 'system' : 'user';
        $(this).text(s.positionExtraImages === 'user' ? 'U' : 'S').toggleClass('pp-position-user', s.positionExtraImages === 'user');
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_position_char_extra').on('click', function () {
        const s = getSettings();
        s.positionGalleryImages = s.positionGalleryImages === 'user' ? 'system' : 'user';
        $(this).text(s.positionGalleryImages === 'user' ? 'U' : 'S').toggleClass('pp-position-user', s.positionGalleryImages === 'user');
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_position_lorebook').on('click', function () {
        const s = getSettings();
        s.positionLorebookImages = s.positionLorebookImages === 'user' ? 'system' : 'user';
        $(this).text(s.positionLorebookImages === 'user' ? 'U' : 'S').toggleClass('pp-position-user', s.positionLorebookImages === 'user');
        getContext().saveSettingsDebounced();
    });

    // Import/Export
    $('#picture_prompt_export').on('click', async function () {
        $(this).prop('disabled', true);
        try {
            const { exportImageData } = await import('./import-export.js');
            await exportImageData();
        } finally {
            $(this).prop('disabled', false);
        }
    });

    $('#picture_prompt_import').on('click', function () {
        $('#picture_prompt_import_file').click();
    });

    $('#picture_prompt_import_file').on('change', async function () {
        const file = this.files?.[0];
        if (!file) return;
        const $exportBtn = $('#picture_prompt_export');
        const $importBtn = $('#picture_prompt_import');
        $exportBtn.prop('disabled', true);
        $importBtn.prop('disabled', true);
        try {
            const { importImageData } = await import('./import-export.js');
            await importImageData(file);
        } finally {
            $exportBtn.prop('disabled', false);
            $importBtn.prop('disabled', false);
            $(this).val('');
        }
    });
}

// ── Settings UI Bootstrap ─────────────────

export async function addSettingsUI() {
    // Derive extension dir name from import.meta.url.
    // Path: .../scripts/extensions/third-party/picture-prompt/modules/settings.js
    // Result: third-party/picture-prompt
    const parts = new URL(import.meta.url).pathname.split('/').filter(Boolean);
    const extIdx = parts.lastIndexOf('extensions');
    const extensionName = parts.slice(extIdx + 1, -2).join('/');
    try {
        const html = await renderExtensionTemplateAsync(extensionName, 'settings');
        $('#extensions_settings').append(html);
        migrateOldSettings();
        applySettingsToUI();
        registerSettingsListeners();
    } catch (err) {
        log.warn('Settings panel unavailable — template not found', err);
        toastr.warning('Settings panel unavailable. Try reinstalling the extension.', 'Picture Prompt');
    }
}

// ── Metadata Helpers ──────────────────────

/**
 * Get metadata list for a persona from extension settings.
 */
export function getMetaForPersona(avatarId) {
    const context = getContext();
    const all = context.extensionSettings[moduleName]?.personaExtraImages;
    if (!all || !all[avatarId]) return [];
    return all[avatarId].map(m => ({ ...m, enabled: m.enabled !== false }));
}

export function setMetaForPersona(avatarId, list) {
    const context = getContext();
    if (!context.extensionSettings[moduleName]) {
        context.extensionSettings[moduleName] = {};
    }
    context.extensionSettings[moduleName].personaExtraImages = {
        ...context.extensionSettings[moduleName].personaExtraImages,
        [avatarId]: list,
    };
    context.saveSettingsDebounced();
}

/**
 * Scan all persona metadata for orphaned entries whose IndexedDB blobs
 * no longer exist, and prune them. Runs once per session on activate().
 */
export async function pruneOrphanedPersonaImages() {
    const context = getContext();
    const all = context.extensionSettings[moduleName]?.personaExtraImages;
    if (!all) return;

    let changed = false;
    for (const [avatarId, metaList] of Object.entries(all)) {
        if (!Array.isArray(metaList) || !metaList.length) continue;
        const keys = metaList.map(m => `${avatarId}::${m.filename}`);
        let records;
        try {
            records = await dbGetAll(keys);
        } catch {
            continue;
        }
        const clean = [];
        for (let i = 0; i < metaList.length; i++) {
            if (records[i]?.blob) {
                clean.push(metaList[i]);
            }
        }
        if (clean.length !== metaList.length) {
            all[avatarId] = clean;
            changed = true;
            log.debug(`Pruned ${metaList.length - clean.length} orphan(s) from persona "${avatarId}"`);
        }
    }
    if (changed) {
        context.saveSettingsDebounced();
    }
}
