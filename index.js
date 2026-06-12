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
import { power_user } from '../../../power-user.js';
import { oai_settings } from '../../../openai.js';
import { getImageSizeFromDataURL } from '../../../utils.js';
import { initLorebookInject, injectLorebookImages, getCachedActiveEntries, deactivateLorebookInject } from './lorebook-inject.js';
import { initLorebookUI, deactivateLorebookUI } from './lorebook-ui.js';
import { openDB, blobToDataURL, escapeHtml, getLorebookSettings, getLorebookImages, getLorebookImagesDataUrls, getCached, setCached, clearFetchCache, STORE_NAME, enableGridDragReorder } from './lorebook-images.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { Popup } from '../../../popup.js';

// ── User Feedback ─────────────────

let _shownErrors = {};

function warnOnce(key, message) {
    if (_shownErrors[key]) return;
    _shownErrors[key] = true;
    toastr.warning(message, 'Picture Prompt');
}

// ── Vision Check ─────────────────

function isImageInliningSupported() {
    if (main_api !== 'openai') {
        warnOnce('api', 'Picture Prompt only works with Chat Completion APIs. Switch to an OpenAI-compatible API (OpenRouter, Ollama, vLLM, etc.)');
        return false;
    }
    if (!oai_settings?.media_inlining) {
        warnOnce('inlining', 'Inline image media is disabled in AI Response settings. Enable it for Picture Prompt to work.');
        return false;
    }
    return true;
}

// ── Avatar Fetching ───────────────────────

function isGroupChat() {
    const chId = Number(this_chid);
    return !Number.isFinite(chId) || chId < 0;
}

/**
 * Resolve a per-source quality override. Returns the global
 * inline_image_quality when the source setting is 'global'.
 * @param {string} sourceSetting - quality override setting for a source
 * @returns {string} 'low', 'auto', or 'high'
 */
function getSourceQuality(sourceSetting) {
    if (!sourceSetting || sourceSetting === 'global') {
        return oai_settings?.inline_image_quality || 'auto';
    }
    return sourceSetting;
}

function getCharacterAvatarUrl() {
    if (isGroupChat()) return null;
    const chId = Number(this_chid);
    if (!characters?.[chId]?.avatar) return null;
    return getThumbnailUrl('avatar', characters[chId].avatar);
}

function getPersonaAvatarUrl() {
    if (!user_avatar) return null;
    return getThumbnailUrl('persona', user_avatar);
}

// ── IndexedDB Blob Storage ────────────────────────

/**
 * @param {string} id - "avatarId::filename"
 * @param {Blob} blob
 * @param {{filename: string, label: string}} meta
 */
async function dbPut(id, blob, meta) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ id, blob, meta, storedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** @returns {Promise<blob: Blob, meta: object}|null>} */
async function dbGet(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Batch-read multiple records from IndexedDB in a single transaction.
 * Used by persona extras and lorebook injection to replace N sequential
 * dbGet() calls with one batched read.
 * @param {string[]} keys
 * @returns {Promise<(object|null)[]>} Results in same order as keys (null if not found).
 */
async function dbGetAll(keys) {
    if (!keys.length) return [];
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const results = new Array(keys.length);
        let remaining = keys.length;
        keys.forEach((key, i) => {
            const req = store.get(key);
            req.onsuccess = () => {
                results[i] = req.result || null;
                if (--remaining === 0) resolve(results);
            };
            req.onerror = () => reject(req.error);
        });
    });
}

async function dbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Get all image IDs for a persona (prefix match).
 * @param {string} avatarId
 * @returns {Promise<string[]>}
 */
async function dbListForPersona(avatarId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => {
            const prefix = `${avatarId}::`;
            resolve((req.result || [])
                .filter(e => e.id.startsWith(prefix))
                .map(e => e.id));
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Delete all images for a persona.
 * @param {string} avatarId
 */
async function dbDeleteAllForPersona(avatarId) {
    const ids = await dbListForPersona(avatarId);
    for (const id of ids) {
        await dbDelete(id);
    }
}

/**
 * Get a displayable URL for an image (prefers in-memory object URL cache).
 * Falls back to fetching the blob from IndexedDB and creating a blob: URL.
 * @param {string} avatarId
 * @param {string} filename
 * @returns {Promise<string|null>}
 */
async function getImageDisplayUrl(avatarId, filename) {
    const id = `${avatarId}::${filename}`;
    const entry = await dbGet(id);
    if (!entry?.blob) return null;
    return URL.createObjectURL(entry.blob);
}

// ── Settings ──────────────────────

const moduleName = 'picture_prompt';

const defaultSettings = {
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
};

function migrateOldSettings() {
    const context = getContext();
    const old = context.extensionSettings?.['avatar_inject'];
    if (!old) return;

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
    // Migrate pre-v1.5 injectTarget to injectChar/injectPersona
    if (s.injectTarget !== undefined) {
        s.injectChar = s.injectChar ?? (s.injectTarget === 'character' || s.injectTarget === 'both');
        s.injectPersona = s.injectPersona ?? (s.injectTarget === 'persona' || s.injectTarget === 'both');
        delete s.injectTarget;
        context.saveSettingsDebounced();
    }
    return s;
}

function applySettingsToUI() {
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
    refreshTokenEstimate();
}

function registerSettingsListeners() {
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
        getSettings().maxExtraImages = parseInt($(this).val(), 10) || 8;
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_char_extra_enabled').on('change', function () {
        getSettings().charExtraImagesEnabled = !!$(this).prop('checked');
        getContext().saveSettingsDebounced();
        $('#pp_gallery_controls').toggle(this.checked);
    });
    $('#picture_prompt_char_extra_max').on('input', function () {
        getSettings().charExtraImagesMax = parseInt($(this).val(), 10) || 8;
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_lorebook_enabled').on('change', function () {
        getSettings().lorebookImagesEnabled = !!$(this).prop('checked');
        getContext().saveSettingsDebounced();
        $('#pp_lorebook_controls').toggle(this.checked);
    });
    $('#picture_prompt_lorebook_max').on('input', function () {
        getSettings().lorebookImagesMax = parseInt($(this).val(), 10) || 4;
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
}

// ── Metadata helpers ──────────────────────

/**
 * Get metadata list for a persona from extension settings.
 * @param {string} avatarId
 * @returns {{id: string, filename: string, label: string}[]}
 */
function getMetaForPersona(avatarId) {
    const context = getContext();
    const all = context.extensionSettings[moduleName]?.personaExtraImages;
    if (!all || !all[avatarId]) return [];
    return all[avatarId].map(m => ({ ...m, enabled: m.enabled !== false }));
}

function setMetaForPersona(avatarId, list) {
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

// ── Character Gallery (via built-in Gallery) ─────────────────

let _pp_injectModeActive = false;
let _pp_galleryObserver = null;
let _pp_personaDropdownObserver = null;

/**
 * Get gallery image selections for a character from settings.
 * @param {string} avatarId - character avatar filename
 * @returns {Object<string, {enabled: boolean}>}
 */
function getCharGalleryMeta(avatarId) {
    const context = getContext();
    const all = context.extensionSettings[moduleName]?.characterGalleryImages;
    if (!all || !all[avatarId]) return {};
    return { ...all[avatarId] };
}

function setCharGalleryMeta(avatarId, obj) {
    const context = getContext();
    if (!context.extensionSettings[moduleName]) {
        context.extensionSettings[moduleName] = {};
    }
    context.extensionSettings[moduleName].characterGalleryImages = {
        ...context.extensionSettings[moduleName].characterGalleryImages,
        [avatarId]: obj,
    };
    context.saveSettingsDebounced();
}

/**
 * Toggle a gallery image's pin state for the current character.
 * @param {string} filename
 */
function toggleCharGalleryImage(filename) {
    const chId = Number(this_chid);
    if (chId < 0 || !characters?.[chId]?.avatar) return;
    const avatarId = characters[chId].avatar;
    const meta = getCharGalleryMeta(avatarId);
    if (meta[filename]?.enabled) {
        meta[filename].enabled = false;
    } else {
        if (!meta[filename]) {
            meta[filename] = { enabled: true, label: '' };
        } else {
            meta[filename].enabled = true;
        }
    }
    setCharGalleryMeta(avatarId, meta);
    // Refresh visual state on thumbnails
    applyCharGallerySelections();
    refreshTokenEstimate();
}

/**
 * Set the label for a gallery image.
 * @param {string} filename
 * @param {string} labelText
 */
function setCharGalleryImageLabel(filename, labelText) {
    const chId = Number(this_chid);
    if (chId < 0 || !characters?.[chId]?.avatar) return;
    const avatarId = characters[chId].avatar;
    const meta = getCharGalleryMeta(avatarId);
    if (!meta[filename]) {
        meta[filename] = { enabled: false, label: '' };
    }
    meta[filename].label = labelText;
    setCharGalleryMeta(avatarId, meta);
}

/**
 * Get the gallery folder name for the current character.
 * Mirrors built-in gallery's getGalleryFolder() logic.
 * @returns {string|null}
 */
function getCharGalleryFolder() {
    const chId = Number(this_chid);
    if (chId < 0 || !characters?.[chId]) return null;
    const char = characters[chId];
    const context = getContext();
    const customFolder = context.extensionSettings?.gallery?.folders?.[char.avatar];
    return customFolder || char.name;
}

/** Apply/refresh "selected" visual class on gallery thumbnail elements. */
function applyCharGallerySelections() {
    const chId = Number(this_chid);
    if (chId < 0 || !characters?.[chId]?.avatar) return;
    const avatarId = characters[chId].avatar;
    const meta = getCharGalleryMeta(avatarId);

    // nanogallery2 renders thumbnails as .nGY2GThumbnail divs with title=filename
    $('#dragGallery .nGY2GThumbnail').each(function () {
        const $el = $(this);
        const filename = $el.attr('title') || '';
        if (!filename) return;
        if (meta[filename]?.enabled) {
            $el.addClass('pp-gallery-selected');
        } else {
            $el.removeClass('pp-gallery-selected');
        }
    });
}

/** Attach gradient label overlay + 🏷 button to gallery thumbnails. */
function attachGalleryLabelButtons() {
    const gallery = document.getElementById('dragGallery');
    if (!gallery) return;

    // Don't attach twice
    if (gallery._pp_labelHandlerAttached) return;

    let _currentThumb = null;
    let _editing = false;

    // Create the 🏷 button (singleton, fixed-position)
    let $btn = $('.pp-gallery-label-btn');
    if (!$btn.length) {
        $btn = $(`<div class="pp-gallery-label-btn" title="Edit label">🏷</div>`);
        $('body').append($btn);
    }

    // Create the gradient overlay (singleton, fixed-position)
    let $overlay = $('.pp-gallery-label-overlay');
    if (!$overlay.length) {
        $overlay = $('<div class="pp-gallery-label-overlay"></div>');
        $('body').append($overlay);
    }

    // Shared: start editing for current thumbnail
    function startLabelEdit() {
        if (!_currentThumb || _editing) return;
        const filename = _currentThumb.getAttribute('title') || '';
        if (!filename) return;
        const chId = Number(this_chid);
        if (chId < 0) return;
        const avatarId = characters?.[chId]?.avatar;
        if (!avatarId) return;
        const meta = getCharGalleryMeta(avatarId);
        const currentLabel = meta[filename]?.label || '';

        _editing = true;
        $btn.removeClass('visible');
        $overlay.addClass('pp-editing');
        $overlay.empty();
        const $input = $(`<input class="pp-label-input" type="text" value="${escapeHtml(currentLabel)}">`);
        $overlay.append($input);
        $input[0].focus();
        $input[0].select();

        function saveLabel() {
            const val = $input.val().trim();
            setCharGalleryImageLabel(filename, val);
            _editing = false;
            $overlay.removeClass('pp-editing');
            if (_currentThumb) {
                const chId2 = Number(this_chid);
                const avId = characters?.[chId2]?.avatar;
                const meta2 = getCharGalleryMeta(avId);
                const lbl = meta2[filename]?.label || '';
                $overlay.text(lbl || '');
            }
        }

        $input.on('blur', saveLabel);
        $input.on('keydown', function (ev) {
            ev.stopPropagation();
            if (ev.key === 'Enter') {
                ev.preventDefault();
                saveLabel();
            } else if (ev.key === 'Escape') {
                $overlay.removeClass('pp-editing');
                $overlay.text(meta[filename]?.label || '');
                _editing = false;
            }
        });
    }

    // 🏷 button click -> edit label
    $btn.off('click').on('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        startLabelEdit();
    });

    // Double-click on overlay -> edit label
    $overlay.off('dblclick').on('dblclick', function (e) {
        e.stopPropagation();
        e.preventDefault();
        startLabelEdit();
    });

    // Show overlay + 🏷 on mouseenter
    gallery.addEventListener('mouseenter', function onEnter(e) {
        const thumb = e.target.closest('.nGY2GThumbnail');
        if (!thumb || _editing) return;
        _currentThumb = thumb;

        const chId = Number(this_chid);
        const avatarId = characters?.[chId]?.avatar;
        const meta = avatarId ? getCharGalleryMeta(avatarId) : {};
        const filename = thumb.getAttribute('title') || '';
        const label = meta[filename]?.label || '';

        const rect = thumb.getBoundingClientRect();
        const overlayHeight = 26;
        $overlay.css({
            top: (rect.bottom - overlayHeight) + 'px',
            left: rect.left + 'px',
            width: rect.width + 'px',
            height: overlayHeight + 'px',
        });
        $overlay.text(label);
        $overlay.addClass('visible');

        $btn.css({
            top: (rect.top + 4) + 'px',
            left: (rect.left + 4) + 'px',
        });
        $btn.addClass('visible');
    }, true);

    // Hide on mouseleave — mouseleave fires on the gallery itself,
    // so we check if any thumbnail is still hovered before hiding.
    gallery.addEventListener('mouseleave', function onLeave(e) {
        setTimeout(() => {
            if (_editing) return;
            const hovered = gallery.querySelector('.nGY2GThumbnail:hover');
            if (!hovered) {
                $overlay.removeClass('visible');
                $btn.removeClass('visible');
                _currentThumb = null;
            }
        }, 50);
    }, true);

    gallery._pp_labelHandlerAttached = true;
}

// ── Panel Watchers (Gallery + Persona) ─────────

/**
 * Consolidated DOM watcher — finds #movingDivs (gallery) and
 * #PersonaManagement (persona panel) using a single body observer.
 * Replaces the previous dual-setTimeout + dual-observer approach.
 */
function startPanelWatchers() {
    let galleryDone = false;
    let personaDone = false;

    function tryInitGallery() {
        if (galleryDone) return;
        const el = document.getElementById('movingDivs');
        if (el) { galleryDone = true; observeGallery(el); }
    }

    function tryInitPersona() {
        if (personaDone) return;
        const el = document.getElementById('PersonaManagement');
        if (el) { personaDone = true; observePersonaPanel(el); }
    }

    // Try immediately — both elements may already be in DOM at activate time
    tryInitGallery();
    tryInitPersona();

    // MutationObserver catches late arrivals (e.g. drawer opens)
    if (typeof MutationObserver !== 'undefined') {
        const obs = new MutationObserver(() => {
            tryInitGallery();
            tryInitPersona();
            if (galleryDone && personaDone) obs.disconnect();
        });
        obs.observe(document.body, { childList: true, subtree: true });

        // Retry fallback for guaranteed convergence
        let retries = 0;
        const retry = () => {
            tryInitGallery();
            tryInitPersona();
            if (galleryDone && personaDone) { obs.disconnect(); return; }
            if (++retries < 15) setTimeout(retry, 2000);
            else { obs.disconnect(); console.debug('[Picture Prompt] Watchers timed out'); }
        };
        setTimeout(retry, 2000);
    }
}

function observeGallery($moving) {
    _pp_galleryObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.id === 'gallery') {
                    onGalleryOpened();
                }
            }
            // Also detect when gallery is removed
            for (const node of m.removedNodes) {
                if (node.id === 'gallery') {
                    onGalleryClosed();
                }
            }
        }
    });
    _pp_galleryObserver.observe($moving, { childList: true });
}

function onGalleryClosed() {
    _pp_injectModeActive = false;

    // Remove overlays if any remain
    document.querySelectorAll('.pp-inject-overlay').forEach(el => el.remove());

    // Remove label overlay and button
    document.querySelectorAll('.pp-gallery-label-overlay, .pp-gallery-label-btn').forEach(el => el.remove());

    const gallery = document.getElementById('gallery');
    if (gallery) gallery.classList.remove('pp-inject-active');

    // Disconnect content observer
    const dragGallery = document.getElementById('dragGallery');
    if (dragGallery) {
        if (dragGallery._pp_contentObserver) {
            dragGallery._pp_contentObserver.disconnect();
            delete dragGallery._pp_contentObserver;
        }
        delete dragGallery._pp_labelHandlerAttached;
    }
}

function onGalleryOpened() {
    console.debug('[Picture Prompt] Gallery opened — injecting inject mode button');

    // Wait a tick for the gallery container to be fully built
    setTimeout(() => {
        injectInjectButtonIntoGallery();
        // Wait a bit more for nanogallery2 thumbnails to render
        setTimeout(() => {
            applyCharGallerySelections();
            attachGalleryLabelButtons();
            if (_pp_injectModeActive) {
                placeInjectOverlays();
            }
            watchGalleryContent();
            refreshTokenEstimate();
        }, 300);
    }, 100);
}

/** Find the gallery's topBarElement and inject the 𖡡 Inject button. */
function injectInjectButtonIntoGallery() {
    const $gallery = $('#gallery');
    if (!$gallery.length) return;

    // The gallery adds sort select, Add Image, Delete Mode, and Folder Restore
    // to a flex container. We inject our button between Delete Mode and Folder Restore.
    // Target: the right_menu_button with fa-trash (delete mode button)
    const $deleteBtn = $gallery.find('.right_menu_button.fa-trash');
    if (!$deleteBtn.length) return;
    // Don't inject twice
    if ($gallery.find('.pp-gallery-inject-btn').length) return;

    const $injectBtn = $(`
        <div class="right_menu_button pp-gallery-inject-btn" title="Inject mode">
            𖡡
        </div>
    `);
    $deleteBtn.after($injectBtn);

    $injectBtn.on('click', function (e) {
        e.stopPropagation();
        _pp_injectModeActive = !_pp_injectModeActive;
        $(this).toggleClass('warning', _pp_injectModeActive);
        toggleInjectOverlays(_pp_injectModeActive);
        if (_pp_injectModeActive) {
            toastr.info('Inject mode ON. Click gallery images to pin them for prompt injection.', undefined, { timeOut: 3000 });
        } else {
            toastr.info('Inject mode OFF.', undefined, { timeOut: 2000 });
        }
    });
}

/** Create or remove inject-mode overlays over gallery thumbnails. */
function toggleInjectOverlays(active) {
    const gallery = document.getElementById('gallery');
    if (!gallery) return;

    if (active) {
        // Add CSS class that blocks pointer events on thumbnails
        gallery.classList.add('pp-inject-active');
        // Place overlays on visible thumbnails
        placeInjectOverlays();
    } else {
        gallery.classList.remove('pp-inject-active');
        // Remove overlay elements (they're on document.body, not inside #gallery)
        document.querySelectorAll('.pp-inject-overlay').forEach(el => el.remove());
    }
}

/** Position transparent overlays over each thumbnail in the current gallery page. */
function placeInjectOverlays() {
    const gallery = document.getElementById('gallery');
    if (!gallery) return;

    // Remove any stale overlays first (they live on document.body)
    document.querySelectorAll('.pp-inject-overlay').forEach(el => el.remove());

    // Get all visible thumbnail elements
    const thumbs = gallery.querySelectorAll('.nGY2GThumbnail');
    if (!thumbs.length) return;

    // Create a relative positioning anchor if not already present
    const subGallery = gallery.querySelector('.nGY2GallerySub') || gallery.querySelector('.nGY2Gallery');
    if (!subGallery) return;

    const galleryRect = gallery.getBoundingClientRect();

    thumbs.forEach(thumb => {
        // Skip already-pinned thumbnails that are in the current page
        const rect = thumb.getBoundingClientRect();
        // Only overlay thumbnails that are actually displayed (have non-zero dimensions)
        if (rect.width === 0 || rect.height === 0) return;

        const overlay = document.createElement('div');
        overlay.className = 'pp-inject-overlay';
        overlay.style.cssText = `
            position: fixed;
            z-index: 10000;
            top: ${rect.top}px;
            left: ${rect.left}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            cursor: pointer;
            background: transparent;
        `;

        const filename = thumb.getAttribute('title') || '';
        overlay.dataset.filename = filename;

        overlay.addEventListener('click', function (e) {
            e.stopPropagation();
            e.preventDefault();
            const fn = this.dataset.filename || '';
            if (fn) toggleCharGalleryImage(fn);
        });

        document.body.appendChild(overlay);
    });
}

/**
 * Watch for gallery content changes (pagination, sort) and re-apply
 * selection visuals + inject overlays.
 */
function watchGalleryContent() {
    const gallery = document.getElementById('dragGallery');
    if (!gallery || gallery._pp_contentObserver) return;

    const observer = new MutationObserver(() => {
        setTimeout(() => {
            applyCharGallerySelections();
            attachGalleryLabelButtons();
            if (_pp_injectModeActive) {
                placeInjectOverlays();
            }
        }, 50);
    });

    observer.observe(gallery, { childList: true, subtree: true });
    gallery._pp_contentObserver = observer;
}

// ── Extra Images in Persona Panel ─────────────────

let _pp_personaPanelObserver = null;
let _pp_panelRendered = false;

/**
 * Attach attributes observer to the persona panel element.
 * Called by startPanelWatchers once #PersonaManagement is found.
 */
function observePersonaPanel($content) {
    checkAndRender();

    _pp_personaPanelObserver = new MutationObserver(function (mutations) {
        for (const m of mutations) {
            if (m.type === 'attributes' && m.attributeName === 'class') {
                checkAndRender();
                break;
            }
        }
    });
    _pp_personaPanelObserver.observe($content, { attributes: true });
}

function checkAndRender() {
    const $content = $('#PersonaManagement');
    if (!$content.length) return;
    if ($content.hasClass('openDrawer')) {
        renderIfPanelOpen();
    }
}

function renderIfPanelOpen() {
    const $panel = $('.persona_management_current_persona');
    if (!$panel.length) return;

    if (_pp_panelRendered) {
        updatePersonaLabel(user_avatar);
        loadPersonaImagesForPanel(user_avatar);
        return;
    }

    _pp_panelRendered = true;
    renderExtraImagesSection(user_avatar);
    loadPersonaImagesForPanel(user_avatar);
}

function renderExtraImagesSection(avatarId) {
    const $panel = $('.persona_management_current_persona');
    if ($panel.find('#pp_extra_images_section').length) return;

    const personaName = power_user?.personas?.[avatarId] || avatarId || 'No persona selected';

    const html = `
        <div id="pp_extra_images_section" class="pp-extra-images-section" data-avatar-id="${escapeHtml(avatarId)}">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Extra Images</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="pp-extra-images-avatar-label" id="pp_extra_images_avatar_label">
                        <i class="fa-solid fa-user"></i> ${escapeHtml(personaName)}
                    </div>
                    <div class="flex-container marginTopBot5">
                        <button id="pp_upload_extra" class="menu_button" title="Upload extra images for this persona">
                            <i class="fa-solid fa-upload margin0"></i> Upload Image
                        </button>
                        <input id="pp_extra_file_input" type="file" hidden accept="image/*" multiple>
                    </div>
                    <div id="pp_extra_images_grid" class="picture-prompt-images-grid"></div>
                    <div id="pp_extra_empty" style="margin-top: 0.5em; color: var(--text-color-dim); font-size: 0.85em;">
                        No extra images for this persona yet.
                    </div>
                </div>
            </div>
        </div>`;

    $panel.append(html);

    $('#pp_upload_extra').on('click', function () {
        $('#pp_extra_file_input').trigger('click');
    });

    $('#pp_extra_file_input').on('change', function () {
        const files = this.files;
        if (!files || files.length === 0) return;
        const currentAvatar = user_avatar;
        if (!currentAvatar) {
            toastr.warning('No persona selected.');
            return;
        }
        uploadExtraImages(currentAvatar, files);
        $(this).val('');
    });
}

/** Load and display extra images from IndexedDB + settings metadata. */
async function loadPersonaImagesForPanel(avatarId) {
    const $grid = $('#pp_extra_images_grid');
    const $empty = $('#pp_extra_empty');

    if (!avatarId) {
        if ($grid.length) $grid.hide();
        if ($empty.length) $empty.show().text('No persona selected.');
        return;
    }

    if ($grid.length) $grid.show();
    if ($empty.length) $empty.hide();
    $grid.html('<span style="font-size:0.85em; color: var(--text-color-dim);">Loading...</span>');

    try {
        const metaList = getMetaForPersona(avatarId);
        const images = [];
        for (const meta of metaList) {
            // Try IndexedDB first, then fall back to checking orphaned files
            const id = `${avatarId}::${meta.filename}`;
            const entry = await dbGet(id);
            if (entry) {
                const objUrl = URL.createObjectURL(entry.blob);
                images.push({ ...meta, objectUrl: objUrl });
            }
        }
        renderImageGrid(images, '#pp_extra_images_grid', avatarId);

        if (images.length === 0) {
            $grid.hide();
            $empty.show().text('No extra images for this persona yet.');
        }
    } catch (err) {
        console.error('[Picture Prompt] Failed to load images:', err);
        $grid.html('<span style="font-size:0.85em; color: #e55;">Failed to load images</span>');
    }
}

function updatePersonaLabel(avatarId) {
    const $label = $('#pp_extra_images_avatar_label');
    if ($label.length) {
        const personaName = power_user?.personas?.[avatarId] || avatarId || 'Unknown';
        $label.html(`<i class="fa-solid fa-user"></i> ${escapeHtml(personaName)}`);
    }
}

function onPersonaChanged(avatarId) {
    clearFetchCache();
    const $panel = $('.persona_management_current_persona');
    if (!$panel.length) return;
    renderIfPanelOpen();
    refreshTokenEstimate();
}

/** Render images into a grid. @param images — array of {filename, label, objectUrl} */
function renderImageGrid(images, gridSelector = '#pp_extra_images_grid', avatarId = null) {
    const $grid = $(gridSelector);
    // Revoke old blob URLs before clearing the grid
    $grid.find('img[src^="blob:"]').each(function () {
        URL.revokeObjectURL(this.src);
    });
    $grid.empty();

    if (!images || images.length === 0) {
        $grid.html('<span style="font-size:0.85em; color: var(--text-color-dim);">No extra images uploaded yet.</span>');
        return;
    }

    const settings = getSettings();
    const displayImages = settings.maxExtraImages > 0
        ? images.slice(0, settings.maxExtraImages)
        : images;

    const targetAvatarId = avatarId || ($('#pp_extra_images_section').data('avatar-id') || '');

    for (const img of displayImages) {
        const $card = $(`
            <div class="picture-prompt-image-card" data-filename="${escapeHtml(img.filename)}">
                <div class="card-image-wrap">
                    <img src="${img.objectUrl}" alt="${escapeHtml(img.filename)}" loading="lazy">
                    <div class="card-label-overlay pp-label-edit" title="Click to edit label">${escapeHtml(img.label || img.filename)}</div>
                </div>
                <div class="card-body">
                    <div class="card-actions">
                        <label class="pp-img-toggle-label" title="Include in prompt">
                            <input type="checkbox" class="pp-img-toggle" data-filename="${escapeHtml(img.filename)}" ${img.enabled !== false ? 'checked' : ''}>
                            <span class="pp-toggle-on">On</span>
                            <span class="pp-toggle-off">Off</span>
                        </label>
                        <button class="menu_button btn-edit-label" data-filename="${escapeHtml(img.filename)}" title="Edit image label">
                            🏷
                        </button>
                        <button class="menu_button btn-delete" data-filename="${escapeHtml(img.filename)}" title="Delete this image">
                            <i class="fa-solid fa-trash-can margin0"></i>
                        </button>
                    </div>
                </div>
            </div>
        `);
        $grid.append($card);
    }

    $grid.find('.btn-delete').off('click').on('click', function () {
        const filename = $(this).data('filename');
        if (!confirm(`Delete "${filename}"?`)) return;
        deleteExtraImage(targetAvatarId, filename);
    });

    $grid.find('.btn-edit-label').off('click').on('click', function () {
        const $card = $(this).closest('.picture-prompt-image-card');
        const $overlay = $card.find('.pp-label-edit');
        startLabelEdit($overlay);
    });

    $grid.find('.pp-img-toggle').off('change').on('change', function () {
        const filename = $(this).data('filename');
        const enabled = $(this).prop('checked');
        const metaList = getMetaForPersona(targetAvatarId);
        const entry = metaList.find(m => m.filename === filename);
        if (entry) {
            entry.enabled = enabled;
            setMetaForPersona(targetAvatarId, metaList);
        }
    });

    // Inline label editing — double-click to edit, blur/Enter to save
    $grid.off('blur', '.pp-label-input').on('blur', '.pp-label-input', function () {
        commitLabelEdit(targetAvatarId, $(this));
    });
    $grid.off('keydown', '.pp-label-input').on('keydown', '.pp-label-input', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            $(this).trigger('blur');
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelLabelEdit($(this));
        }
    });
    $grid.off('dblclick', '.pp-label-edit').on('dblclick', '.pp-label-edit', function () {
        startLabelEdit($(this));
    });

    // Enable drag-to-reorder
    enableGridDragReorder(gridSelector,
        () => getMetaForPersona(targetAvatarId),
        (arr) => setMetaForPersona(targetAvatarId, arr));
}

// ── Inline Label Editing Helpers ─────────

function startLabelEdit($overlay) {
    if ($overlay.find('input').length) return; // already editing
    const currentText = $overlay.text();
    $overlay.data('pp-original-label', currentText);
    $overlay.addClass('pp-editing');
    $overlay.html(`<input type="text" class="pp-label-input" value="${escapeHtml(currentText)}">`);
    const $input = $overlay.find('input');
    $input.focus().select();
}

function commitLabelEdit(avatarId, $input) {
    const $overlay = $input.parent();
    const filename = $overlay.closest('.picture-prompt-image-card').data('filename');
    const newLabel = $input.val().trim();

    // Update metadata
    const metaList = getMetaForPersona(avatarId);
    const entry = metaList.find(m => m.filename === filename);
    if (entry) {
        entry.label = newLabel;
        setMetaForPersona(avatarId, metaList);
    }

    // Restore display
    const displayText = newLabel || filename;
    $overlay.removeClass('pp-editing').text(displayText);
}

function cancelLabelEdit($input) {
    const $overlay = $input.parent();
    const originalText = $overlay.data('pp-original-label') || '';
    $overlay.removeClass('pp-editing').text(originalText);
}

// ── Upload / Delete (IndexedDB) ───────────────────

async function uploadExtraImages(avatarId, files) {
    const settings = getSettings();
    const maxImages = settings.maxExtraImages || 8;

    try {
        // Count existing images from metadata
        const existing = getMetaForPersona(avatarId);
        const currentCount = existing.length;
        const remaining = maxImages - currentCount;

        if (remaining <= 0) {
            toastr.warning(`Maximum of ${maxImages} extra images reached for this persona.`);
            return;
        }

        const filesToUpload = Array.from(files).slice(0, remaining);
        if (filesToUpload.length < files.length) {
            toastr.warning(`Only uploading ${filesToUpload.length} of ${files.length} — limit is ${maxImages} images.`);
        }
        if (filesToUpload.length === 0) return;

        for (const file of filesToUpload) {
            // Validate image type
            if (!/\.(jpg|jpeg|png|gif|webp|bmp|apng|tif|tiff)$/i.test(file.name)) {
                toastr.warning(`"${file.name}" is not a supported image type.`);
                continue;
            }

            // Generate unique filename to avoid collisions
            const base = file.name.replace(/\.[^.]+$/, '');
            const ext = (file.name.match(/\.[^.]+$/) || ['.png'])[0];
            const filename = `${base}_${Date.now()}${ext}`;

            const id = `${avatarId}::${filename}`;
            const blob = new Blob([await file.arrayBuffer()], { type: file.type });
            const label = base.replace(/[_-]/g, ' ');

            await dbPut(id, blob, { filename, label });

            // Save metadata
            const metaList = getMetaForPersona(avatarId);
            metaList.push({ id, filename, label });
            setMetaForPersona(avatarId, metaList);
        }

        toastr.success(`Uploaded ${filesToUpload.length} image(s)`);
        loadPersonaImagesForPanel(avatarId);
    } catch (err) {
        console.error('[Picture Prompt] Upload failed:', err);
        toastr.error('Upload failed. Check console for details.');
    }
}

async function deleteExtraImage(avatarId, filename) {
    try {
        const id = `${avatarId}::${filename}`;
        await dbDelete(id);

        // Remove from metadata
        const metaList = getMetaForPersona(avatarId).filter(m => m.filename !== filename);
        setMetaForPersona(avatarId, metaList);

        toastr.success('Image deleted');
        loadPersonaImagesForPanel(avatarId);
    } catch (err) {
        console.error('[Picture Prompt] Delete failed:', err);
        toastr.error('Delete failed. Check console for details.');
    }
}

// ── Prompt Injection ──────────────────────

// ── Token Estimation ──────────────────────

const IMAGE_TOKENS_LOW = 85; // OpenAI: low-detail images cost 85 tokens

/**
 * Estimate token cost for a single image.
 * Mirrors openai.js Message.getImageTokenCost().
 * @param {string} dataUrl - base64 data URL
 * @param {string} quality - 'low', 'auto', or 'high'
 * @returns {Promise<number>}
 */
async function estimateImageTokens(dataUrl, quality) {
    if (quality === 'low') {
        return IMAGE_TOKENS_LOW;
    }

    try {
        const size = await getImageSizeFromDataURL(dataUrl);

        // Small images with auto quality get low cost
        if (quality === 'auto' && size.width <= 512 && size.height <= 512) {
            return IMAGE_TOKENS_LOW;
        }

        // High-detail: scale → 2048 fit → shortest to 768 → count 512px squares
        const scale = 2048 / Math.min(size.width, size.height);
        const scaledWidth = Math.round(size.width * scale);
        const scaledHeight = Math.round(size.height * scale);

        const finalScale = 768 / Math.min(scaledWidth, scaledHeight);
        const finalWidth = Math.round(scaledWidth * finalScale);
        const finalHeight = Math.round(scaledHeight * finalScale);

        const squares = Math.ceil(finalWidth / 512) * Math.ceil(finalHeight / 512);
        return squares * 170 + 85;
    } catch {
        // If we can't get the size, fall back to low estimate
        return IMAGE_TOKENS_LOW;
    }
}

/**
 * Estimate total tokens for all images that will be injected.
 * @returns {Promise<{low: number, high: number, auto: number, imageCount: number}>}
 */
async function getTotalImageTokenEstimate() {
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
                sources.push({ name: 'Char', quality: s.qualityCharAvatar });
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
                sources.push({ name: 'Persona', quality: s.qualityPersonaAvatar });
            }
        }
    }

    // Persona extra images
    if (s.extraImagesEnabled && user_avatar) {
        const extras = await getExtraImagesForInjection(user_avatar);
        const q = getSourceQuality(s.qualityExtraImages);
        for (const img of extras) {
            total += await estimateImageTokens(img.dataUrl, q);
            imageCount++;
        }
        if (extras.length) sources.push({ name: 'Extras', quality: s.qualityExtraImages });
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
            const maxCount = s.charExtraImagesMax || 8;
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
                    if (galleryCount) sources.push({ name: 'Gallery', quality: s.qualityGalleryImages });
                }
            }
        }
    }

    // Lorebook images — iterate cached active entries
    if (s.lorebookImagesEnabled) {
        const lbSettings = getLorebookSettings();
        const entries = getCachedActiveEntries();
        let lbInjected = 0;
        const lbMax = lbSettings.lorebookImagesMax || 4;
        const q = getSourceQuality(s.qualityLorebookImages);
        for (const [, entry] of entries) {
            if (lbInjected >= lbMax) break;
            const images = getLorebookImages(entry.world || '', String(entry.uid));
            const enabledImages = images.filter(img => img.enabled !== false);
            const wName = entry.world || '';
            const uid = String(entry.uid);

            const toInject = enabledImages.slice(0, lbMax - lbInjected);
            if (!toInject.length) break;

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
        if (lbInjected) sources.push({ name: 'Lorebook', quality: s.qualityLorebookImages });
    }

    return { total, imageCount, sources };
}

let _tokenEstimateRunning = false;
let _tokenEstimatePending = false;

/** Show 'calculating...' instantly — call this BEFORE refreshTokenEstimate()
 *  from early hooks (click, MutationObserver) that fire before ST's events. */
function showCalculating() {
    const $el = $('#picture_prompt_token_estimate');
    if ($el.length && getSettings().enabled) {
        $el.text('calculating...').css('color', 'var(--text-color-dim)');
    }
}

async function refreshTokenEstimate() {
    // Guard: if already running, mark pending and bail — will re-run when done
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

        // Re-check DOM — might have been torn down during async work
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
                detailParts.push(`${src.name}: ${qLabel}`);
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
        // If another call arrived while we were busy, run one more time
        if (_tokenEstimatePending) {
            _tokenEstimatePending = false;
            refreshTokenEstimate();
        }
    }
}

/**
 * Get extra images for a persona: reads metadata from settings,
 * fetches blobs from IndexedDB, converts to base64 data URLs.
 * Result is cached so token estimation and injection share one fetch.
 * @param {string} avatarId
 * @returns {Promise<{filename: string, dataUrl: string, label: string}[]>}
 */
async function getExtraImagesForInjection(avatarId) {
    const cacheKey = 'extra::' + avatarId;
    const cached = getCached(cacheKey);
    if (cached !== undefined) return cached;

    const metaList = getMetaForPersona(avatarId);
    const enabledMeta = metaList.filter(m => m.enabled !== false);
    if (!enabledMeta.length) return [];

    // Batch-read all blobs in a single IndexedDB transaction
    const keys = enabledMeta.map(m => `${avatarId}::${m.filename}`);
    const records = await dbGetAll(keys);

    // Convert blobs to data URLs in parallel
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
async function urlToBase64(url) {
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

function findMessageTarget(chat) {
    const system = chat.find(m => m.role === 'system');
    if (system) return system;
    return chat.find(m => m.role === 'user') || null;
}

function ensureContentBlocks(msg) {
    if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content }];
        return true;
    }
    if (Array.isArray(msg.content)) {
        // Guard against empty content array — inject a text block
        if (msg.content.length === 0) {
            msg.content.push({ type: 'text', text: '' });
        }
        return true;
    }
    return false;
}

/** Find the first text block in msg.content, or push a new one. */
function getFirstTextBlock(msg) {
    const block = msg.content.find(b => b.type === 'text');
    if (block) return block;
    const newBlock = { type: 'text', text: '' };
    msg.content.push(newBlock);
    return newBlock;
}

async function onPromptReady(eventData) {
    const s = getSettings();
    if (!s.enabled) return;
    if (!isImageInliningSupported()) return;

    const { chat } = eventData;
    if (!chat?.length) return;

    // Read lorebook settings once — thread to sub-functions
    const lbSettings = getLorebookSettings();

    // Fallback target for gallery/extras and when specific messages are missing
    const msg = findMessageTarget(chat);
    if (!msg) return;
    if (!ensureContentBlocks(msg)) return;

    const context = getContext();
    const userName = context.name1 || 'User';
    const charName = context.name2 || 'Character';

    // Read and resolve persona description for injection target matching
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

    /**
     * Get all text content from a message as a single string.
     */
    function getMessageText(m) {
        return Array.isArray(m.content)
            ? m.content.filter(b => b.type === 'text').map(b => b.text).join('')
            : String(m.content);
    }

    /**
     * Inject an image block into a message's content, right after the last text block.
     */
    function injectImageToMessage(targetMsg, base64Data, label, quality) {
        if (label) targetMsg.content.push({ type: 'text', text: '\n' + label });
        targetMsg.content.push({ type: 'image_url', image_url: { url: base64Data, detail: quality } });
    }

    // Inject character avatar — into the system message containing the raw personality text
    // Skip entirely in group chats (no character context); persona + lorebook still work.
    if (s.injectChar && !isGroupChat()) {
        let charTarget = msg;
        const url = getCharacterAvatarUrl();
        if (url) {
            const base64Data = await urlToBase64(url);
            if (base64Data) {
                const label = resolveLabel(s.labelChar);
                // Read raw character personality from character data, then find the system
                // message that contains it (works regardless of prompt format/preset).
                // Falls back to character description if personality is empty.
                let charSearchText = '';
                try {
                    charSearchText = (characters?.[chId]?.data?.personality || '').trim();
                    if (!charSearchText) {
                        charSearchText = (characters?.[chId]?.data?.description || '').trim();
                    }
                } catch {}
                // Resolve template variables
                charSearchText = charSearchText.replace(/{{user}}/gi, userName).replace(/{{char}}/gi, charName);
                const charMsg = charSearchText
                    ? chat.find(m => m.role === 'system' && getMessageText(m).includes(charSearchText))
                    : null;
                if (charMsg && ensureContentBlocks(charMsg)) {
                    injectImageToMessage(charMsg, base64Data, label, getSourceQuality(s.qualityCharAvatar));
                    charTarget = charMsg;
                } else {
                    injectImageToMessage(msg, base64Data, label, getSourceQuality(s.qualityCharAvatar));
                }
            } else {
                warnOnce('char-fetch', 'Failed to load character avatar image');
            }
        } else {
            warnOnce('char-missing', 'No character avatar set. Set one in the character panel.');
        }

        // Character gallery extras — land right after character avatar in the same message
        if (s.charExtraImagesEnabled) {
            await injectCharGalleryImages(charTarget, getSourceQuality(s.qualityGalleryImages), s.charExtraImagesMax);
        }
    } else if (s.injectChar && isGroupChat()) {
        warnOnce('group-chat', 'Character avatar and gallery injection skipped — not available in group chats. Persona and lorebook injection still active.');
    }

    // Lorebook images — inject into system messages alongside world info text
    if (s.lorebookImagesEnabled) {
        await injectLorebookImages(chat, getSourceQuality(s.qualityLorebookImages), lbSettings);
    }

    // Inject persona avatar — into the system message containing the persona description text
    if (s.injectPersona) {
        let personaTarget = msg;
        const url = getPersonaAvatarUrl();
        if (url) {
            const base64Data = await urlToBase64(url);
            if (base64Data) {
                const label = resolveLabel(s.labelUser);
                // resolvedPersonaDesc is already resolved above
                const personaMsg = resolvedPersonaDesc
                    ? chat.find(m => m.role === 'system' && getMessageText(m).includes(resolvedPersonaDesc))
                    : null;
                if (personaMsg && ensureContentBlocks(personaMsg)) {
                    injectImageToMessage(personaMsg, base64Data, label, getSourceQuality(s.qualityPersonaAvatar));
                    personaTarget = personaMsg;
                } else {
                    injectImageToMessage(msg, base64Data, label, getSourceQuality(s.qualityPersonaAvatar));
                }
            } else {
                warnOnce('persona-fetch', 'Failed to load persona avatar image');
            }
        } else {
            warnOnce('persona-missing', 'No persona avatar set. Set one in the persona panel.');
        }

        // Persona extra images — land right after persona avatar in the same message
        if (s.extraImagesEnabled && user_avatar) {
            const extras = await getExtraImagesForInjection(user_avatar);
            for (const img of extras) {
                const perImageLabel = (img.label || '').trim();
                if (perImageLabel) {
                    personaTarget.content.push({ type: 'text', text: '\n' + perImageLabel });
                }
                personaTarget.content.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: getSourceQuality(s.qualityExtraImages) } });
            }
        }
    }
}

/**
 * Fetch enabled character gallery images and inject them into the prompt.
 * @param {object} msg - the target message with content array
 * @param {string} quality - image detail level
 * @param {number} maxCount - pre-read from settings (charExtraImagesMax)
 */
async function injectCharGalleryImages(msg, quality, maxCount) {
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

    const effectiveMax = maxCount || 8;
    const toInject = enabledFilenames.slice(0, effectiveMax);

    for (const filename of toInject) {
        // Build gallery image URL — same pattern as gallery: user/images/{folder}/{filename}
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

// ── Init ──────────────────

const extensionName = new URL(import.meta.url).pathname
    .replace('/scripts/extensions/', '')
    .replace('/index.js', '');

async function addSettingsUI() {
    try {
        const html = await renderExtensionTemplateAsync(extensionName, 'settings');
        $('#extensions_settings').append(html);
        migrateOldSettings();
        applySettingsToUI();
        registerSettingsListeners();
    } catch (err) {
        console.warn('[Picture Prompt] Settings panel unavailable — template not found', err);
        toastr.warning('Settings panel unavailable. Try reinstalling the extension.', 'Picture Prompt');
    }
}

// ── Named event handlers (for deactivate cleanup) ────

function _onChatChanged() {
    clearFetchCache();
    refreshTokenEstimate();
}

function _onSettingsUpdated() {
    refreshTokenEstimate();
}

function _onChatBlockClick(e) {
    if ($(e.target).closest('.PastChat_cross, .exportRawChatButton, .exportChatButton, .renameChatButton').length) return;
    showCalculating();
}

// ── Slash Commands ─────────────────

async function ppStatusCallback() {
    const s = getSettings();
    const lbSettings = getLorebookSettings();
    const lines = ['<h3>Picture Prompt Status</h3>', '<table style="width:100%;border-collapse:collapse;">'];

    const row = (k, v) => `<tr><td style="padding:4px 12px 4px 0;white-space:nowrap;color:var(--text-color-dim);">${k}</td><td style="padding:4px 0;">${v}</td></tr>`;

    lines.push(row('Enabled', s.enabled ? '✓ <span style="color:var(--success-color);">yes</span>' : '✗ <span style="color:var(--error-color);">no</span>'));
    lines.push(row('Character avatar', s.injectChar ? '✓ <span style="color:var(--success-color);">enabled</span>' : '✗ disabled'));
    lines.push(row('Persona avatar', s.injectPersona ? '✓ <span style="color:var(--success-color);">enabled</span>' : '✗ disabled'));

    // Persona extras
    if (user_avatar) {
        const meta = getMetaForPersona(user_avatar);
        const enabled = meta.filter(m => m.enabled !== false).length;
        lines.push(row('Persona extras', `${meta.length} images (${enabled} enabled, max ${s.maxExtraImages})`));
    } else {
        lines.push(row('Persona extras', 'no persona selected'));
    }

    // Gallery pins
    const chId = Number(this_chid);
    if (!isGroupChat() && chId >= 0 && characters?.[chId]?.avatar) {
        const avatarId = characters[chId].avatar;
        const meta = getCharGalleryMeta(avatarId);
        const selected = Object.values(meta).filter(v => v.enabled).length;
        lines.push(row('Gallery pins', `${selected} selected (max ${s.charExtraImagesMax})`));
    } else if (isGroupChat()) {
        lines.push(row('Gallery pins', '<span style="color:var(--text-color-dim);">skipped — group chat</span>'));
    } else {
        lines.push(row('Gallery pins', 'no character'));
    }

    // Lorebook
    const lbEntries = getCachedActiveEntries();
    let lbImageCount = 0;
    for (const [, entry] of lbEntries) {
        const imgs = getLorebookImages(entry.world || '', String(entry.uid));
        lbImageCount += imgs.filter(img => img.enabled !== false).length;
    }
    lines.push(row('Lorebook', lbSettings.lorebookImagesEnabled
        ? `✓ <span style="color:var(--success-color);">enabled</span>, ${lbEntries.size} active entries (${lbImageCount} images, max ${lbSettings.lorebookImagesMax})`
        : '✗ disabled'));

    // Group chat warning
    if (isGroupChat()) {
        lines.push(row('Group chat', '<span style="color:#ffd700;">⚠ character features skipped</span>'));
    }

    lines.push('</table>');
    Popup.show.text('Picture Prompt', lines.join(''));
    return '';
}

async function ppImagesCallback() {
    const s = getSettings();
    const lbSettings = getLorebookSettings();
    const lines = ['<h3>Injection Plan</h3>'];

    const item = (label, value) => `<p style="margin:4px 0;"><span style="color:var(--text-color-dim);">${label}:</span> ${escapeHtml(String(value))}</p>`;

    // Character avatar
    if (s.injectChar && !isGroupChat()) {
        const url = getCharacterAvatarUrl();
        const qLabel = s.qualityCharAvatar === 'global' ? '' : ` · ${s.qualityCharAvatar}`;
        lines.push(item('Character avatar', (url ? '✓ available' : '✗ not set') + qLabel));
    } else if (isGroupChat() && s.injectChar) {
        lines.push(item('Character avatar', 'skipped — group chat'));
    }

    // Gallery pins
    const chId = Number(this_chid);
    if (s.charExtraImagesEnabled && !isGroupChat() && chId >= 0 && characters?.[chId]?.avatar) {
        const avatarId = characters[chId].avatar;
        const meta = getCharGalleryMeta(avatarId);
        const pinned = Object.entries(meta).filter(([, v]) => v.enabled);
        const max = s.charExtraImagesMax || 8;
        const qLabel = s.qualityGalleryImages === 'global' ? '' : ` · ${s.qualityGalleryImages}`;
        if (pinned.length) {
            const list = pinned.slice(0, max).map(([fn, v]) => v.label || fn).join(', ');
            lines.push(item(`Gallery pins (${Math.min(pinned.length, max)} of ${pinned.length} selected, max ${max})${qLabel}`, list));
        } else {
            lines.push(item('Gallery pins', 'none selected'));
        }
    }

    // Persona avatar
    if (s.injectPersona) {
        const url = getPersonaAvatarUrl();
        const qLabel = s.qualityPersonaAvatar === 'global' ? '' : ` · ${s.qualityPersonaAvatar}`;
        lines.push(item('Persona avatar', (url ? '✓ available' : '✗ not set') + qLabel));
    }

    // Persona extras
    if (s.extraImagesEnabled && user_avatar) {
        const meta = getMetaForPersona(user_avatar);
        const enabled = meta.filter(m => m.enabled !== false);
        const qLabel = s.qualityExtraImages === 'global' ? '' : ` · ${s.qualityExtraImages}`;
        if (enabled.length) {
            const max = s.maxExtraImages || 8;
            const list = enabled.slice(0, max).map(m => m.label || m.filename).join(', ');
            lines.push(item(`Persona extras (${Math.min(enabled.length, max)} of ${enabled.length} enabled, max ${max})${qLabel}`, list));
        } else {
            lines.push(item('Persona extras', 'none enabled'));
        }
    }

    // Lorebook
    if (s.lorebookImagesEnabled) {
        const entries = getCachedActiveEntries();
        const lbQ = s.qualityLorebookImages === 'global' ? '' : ` · ${s.qualityLorebookImages}`;
        if (entries.size) {
            const max = lbSettings.lorebookImagesMax || 4;
            let remaining = max;
            const entryLines = [];
            for (const [, entry] of entries) {
                if (remaining <= 0) break;
                const wName = entry.world || '';
                const uid = String(entry.uid);
                const imgs = getLorebookImages(wName, uid);
                const enabled = imgs.filter(img => img.enabled !== false);
                const toShow = enabled.slice(0, remaining);
                if (toShow.length) {
                    const title = entry.comment || uid;
                    const imgList = toShow.map(img => img.label || img.filename).join(', ');
                    entryLines.push(`<li>"${escapeHtml(title)}" → ${imgList}</li>`);
                    remaining -= toShow.length;
                }
            }
            if (entryLines.length) {
                lines.push(`<p style="margin:4px 0;"><span style="color:var(--text-color-dim);">Lorebook (${entries.size} active, max ${max})${lbQ}:</span></p><ul style="margin:4px 0;">${entryLines.join('')}</ul>`);
            } else {
                lines.push(item('Lorebook', `${entries.size} active entries, no enabled images`));
            }
        } else {
            lines.push(item('Lorebook', 'no active entries'));
        }
    }

    if (lines.length === 1) {
        lines.push('<p style="color:var(--text-color-dim);">No images configured for injection.</p>');
    }

    Popup.show.text('Picture Prompt', lines.join(''));
    return '';
}

async function ppCacheCallback() {
    clearFetchCache();
    toastr.success('Image data URL cache cleared', 'Picture Prompt');
    return '';
}

export async function activate() {
    getSettings();
    await addSettingsUI();
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.on(event_types.PERSONA_CHANGED, onPersonaChanged);
    eventSource.on(event_types.CHAT_CHANGED, _onChatChanged);
    eventSource.on(event_types.SETTINGS_UPDATED, _onSettingsUpdated);
    startPanelWatchers();
    initLorebookUI();
    initLorebookInject();

    // ── Slash commands ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pp-status',
        callback: ppStatusCallback,
        helpString: 'Show Picture Prompt extension status',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pp-images',
        callback: ppImagesCallback,
        helpString: 'Show what images would be injected on the next message',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pp-cache',
        callback: ppCacheCallback,
        helpString: 'Clear the image data URL cache',
    }));

    // ── Early-visible 'calculating...' hooks ─────────────────────
    // ST's event system fires late — these bridge the visual gap by
    // showing 'calculating...' before the real estimate runs.

    // Chat block clicks (chat switcher)
    $(document).on('click', '.select_chat_block', _onChatBlockClick);

    // Persona dropdown changes — fires before PERSONA_CHANGED event
    if (typeof MutationObserver !== 'undefined') {
        _pp_personaDropdownObserver = new MutationObserver(() => showCalculating());
        // Observe after a short delay — the dropdown may not be in DOM yet
        const tryObservePersona = () => {
            const $dd = $('#persona-management-dropdown');
            if ($dd.length) {
                _pp_personaDropdownObserver.observe($dd[0], { subtree: true, childList: true, characterData: true });
            } else {
                setTimeout(tryObservePersona, 200);
            }
        };
        setTimeout(tryObservePersona, 100);
    }

    console.debug('[Picture Prompt] Activated');
    refreshTokenEstimate();
}

export async function deactivate() {
    // ── MutationObservers ──
    _pp_galleryObserver?.disconnect();
    _pp_galleryObserver = null;
    _pp_personaPanelObserver?.disconnect();
    _pp_personaPanelObserver = null;
    _pp_personaDropdownObserver?.disconnect();
    _pp_personaDropdownObserver = null;

    // Gallery content observer (attached to DOM element, not module-level)
    const dragGallery = document.getElementById('dragGallery');
    if (dragGallery?._pp_contentObserver) {
        dragGallery._pp_contentObserver.disconnect();
        delete dragGallery._pp_contentObserver;
    }

    // ── jQuery global delegate ──
    $(document).off('click', '.select_chat_block', _onChatBlockClick);

    // ── EventSource listeners ──
    eventSource.removeListener(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.removeListener(event_types.PERSONA_CHANGED, onPersonaChanged);
    eventSource.removeListener(event_types.CHAT_CHANGED, _onChatChanged);
    eventSource.removeListener(event_types.SETTINGS_UPDATED, _onSettingsUpdated);

    // ── Sub-modules ──
    deactivateLorebookUI();
    deactivateLorebookInject();

    console.debug('[Picture Prompt] Deactivated');
}
