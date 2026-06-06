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
import { initLorebookInject, injectLorebookImages } from './lorebook-inject.js';
import { initLorebookUI } from './lorebook-ui.js';
import { openDB, blobToDataURL, escapeHtml } from './lorebook-images.js';

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

function getCharacterAvatarUrl() {
    const chId = Number(this_chid);
    if (chId < 0 || !characters?.[chId]?.avatar) return null;
    return getThumbnailUrl('avatar', characters[chId].avatar);
}

function getPersonaAvatarUrl() {
    if (!user_avatar) return null;
    return getThumbnailUrl('persona', user_avatar);
}

// ── IndexedDB Blob Storage ────────────────────────

const DB_NAME = 'PicturePrompt';
const DB_VERSION = 1;
const STORE_NAME = 'extraImages';

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
    injectTarget: 'character',
    labelChar: 'This is how you look:',
    labelUser: 'This is how {{user}} looks:',
    extraImagesEnabled: true,
    maxExtraImages: 8,
    charExtraImagesEnabled: false,
    charExtraImagesMax: 8,
    lorebookImagesEnabled: false,
    lorebookImagesMax: 4,
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
    return s;
}

function applySettingsToUI() {
    const s = getSettings();
    $('#picture_prompt_enabled').prop('checked', s.enabled);
    $('#picture_prompt_target').val(s.injectTarget);
    $('#picture_prompt_label_char').val(s.labelChar || '');
    $('#picture_prompt_label_user').val(s.labelUser || '');
    $('#picture_prompt_extra_images_enabled').prop('checked', s.extraImagesEnabled ?? true);
    $('#picture_prompt_extra_images_max').val(s.maxExtraImages ?? 8);
    $('#picture_prompt_char_extra_enabled').prop('checked', s.charExtraImagesEnabled ?? false);
    $('#picture_prompt_char_extra_max').val(s.charExtraImagesMax ?? 8);
    $('#picture_prompt_lorebook_enabled').prop('checked', s.lorebookImagesEnabled ?? false);
    $('#picture_prompt_lorebook_max').val(s.lorebookImagesMax ?? 4);
    refreshTokenEstimate();
}

function registerSettingsListeners() {
    $('#picture_prompt_enabled').on('change', function () {
        getSettings().enabled = !!$(this).prop('checked');
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_target').on('change', function () {
        getSettings().injectTarget = String($(this).val());
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
    $('#picture_prompt_extra_images_enabled').on('change', function () {
        getSettings().extraImagesEnabled = !!$(this).prop('checked');
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_extra_images_max').on('input', function () {
        getSettings().maxExtraImages = parseInt($(this).val(), 10) || 8;
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_char_extra_enabled').on('change', function () {
        getSettings().charExtraImagesEnabled = !!$(this).prop('checked');
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_char_extra_max').on('input', function () {
        getSettings().charExtraImagesMax = parseInt($(this).val(), 10) || 8;
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_lorebook_enabled').on('change', function () {
        getSettings().lorebookImagesEnabled = !!$(this).prop('checked');
        getContext().saveSettingsDebounced();
    });
    $('#picture_prompt_lorebook_max').on('input', function () {
        getSettings().lorebookImagesMax = parseInt($(this).val(), 10) || 4;
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

// ── Gallery Watcher ─────────────────

function startGalleryWatcher() {
    const $moving = document.getElementById('movingDivs');
    if (!$moving) {
        // Retry once after a short delay
        setTimeout(() => {
            const el = document.getElementById('movingDivs');
            if (el) observeGallery(el);
        }, 2000);
        return;
    }
    observeGallery($moving);
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

function startPersonaPanelWatcher() {
    const $content = $('#PersonaManagement');
    if (!$content.length) {
        // Retry up to ~30s for the persona panel to appear in DOM.
        // The MutationObserver approach catches it immediately when it does,
        // but we need a fallback in case it never fires.
        let retries = 0;
        const maxRetries = 15;
        const check = () => {
            if ($('#PersonaManagement').length) {
                startPersonaPanelWatcher();
                return;
            }
            if (++retries < maxRetries) {
                setTimeout(check, 2000);
            } else {
                console.debug('[Picture Prompt] Persona panel never appeared — watcher not started');
            }
        };
        // MutationObserver for early detection, retry timer as fallback
        const observer = new MutationObserver((_mutations, obs) => {
            if ($('#PersonaManagement').length) {
                obs.disconnect();
                startPersonaPanelWatcher();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(check, 2000);
        return;
    }

    checkAndRender();

    _pp_personaPanelObserver = new MutationObserver(function (mutations) {
        for (const m of mutations) {
            if (m.type === 'attributes' && m.attributeName === 'class') {
                checkAndRender();
                break;
            }
        }
    });
    _pp_personaPanelObserver.observe($content[0], { attributes: true });
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
    const quality = oai_settings?.inline_image_quality || 'auto';
    let totalLow = 0;
    let totalHigh = 0;
    let totalAuto = 0;
    let imageCount = 0;

    // Character avatar
    if (s.injectTarget === 'character' || s.injectTarget === 'both') {
        const url = getCharacterAvatarUrl();
        if (url) {
            const b64 = await urlToBase64(url);
            if (b64) {
                totalLow += await estimateImageTokens(b64, 'low');
                totalHigh += await estimateImageTokens(b64, 'high');
                totalAuto += await estimateImageTokens(b64, 'auto');
                imageCount++;
            }
        }
    }

    // Persona avatar
    if (s.injectTarget === 'persona' || s.injectTarget === 'both') {
        const url = getPersonaAvatarUrl();
        if (url) {
            const b64 = await urlToBase64(url);
            if (b64) {
                totalLow += await estimateImageTokens(b64, 'low');
                totalHigh += await estimateImageTokens(b64, 'high');
                totalAuto += await estimateImageTokens(b64, 'auto');
                imageCount++;
            }
        }
    }

    // Persona extra images
    if (s.extraImagesEnabled && user_avatar) {
        const extras = await getExtraImagesForInjection(user_avatar);
        for (const img of extras) {
            totalLow += await estimateImageTokens(img.dataUrl, 'low');
            totalHigh += await estimateImageTokens(img.dataUrl, 'high');
            totalAuto += await estimateImageTokens(img.dataUrl, 'auto');
            imageCount++;
        }
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
                    for (const filename of toInject) {
                        const url = `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
                        const b64 = await urlToBase64(url);
                        if (b64) {
                            totalLow += await estimateImageTokens(b64, 'low');
                            totalHigh += await estimateImageTokens(b64, 'high');
                            totalAuto += await estimateImageTokens(b64, 'auto');
                            imageCount++;
                        }
                    }
                }
            }
        }
    }

    // Lorebook images — token count varies by active entries; not included in estimate

    return { low: totalLow, high: totalHigh, auto: totalAuto, imageCount };
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
            const quality = oai_settings?.inline_image_quality || 'auto';
            const provider = main_api;

            let contextLabel = '';
            if (provider === 'openai') {
                if (quality === 'low') contextLabel = 'OpenAI · low detail';
                else if (quality === 'high') contextLabel = 'OpenAI · high detail';
                else contextLabel = 'OpenAI · auto detail';
            } else if (provider === 'anthropic') {
                contextLabel = 'Claude · pixel-based';
            } else if (provider === 'google') {
                contextLabel = 'Gemini · tiled';
            } else {
                contextLabel = quality === 'low' ? 'Low detail' : quality === 'high' ? 'High detail' : 'Auto detail';
            }

            if (quality === 'low') {
                $el2.text(`≈ ${est.low} tokens`).css('color', 'var(--success-color, #4caf50)');
            } else if (quality === 'high') {
                $el2.text(`≈ ${est.high} tokens`).css('color', 'var(--success-color, #4caf50)');
            } else {
                $el2.text(`≈ ${est.auto} tokens`).css('color', 'var(--success-color, #4caf50)');
            }
            $detail2.text(`${est.imageCount} image${est.imageCount !== 1 ? 's' : ''} · ${contextLabel}`);
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
 * @param {string} avatarId
 * @returns {Promise<{filename: string, dataUrl: string, label: string}[]>}
 */
async function getExtraImagesForInjection(avatarId) {
    const metaList = getMetaForPersona(avatarId);
    const enabledMeta = metaList.filter(m => m.enabled !== false);
    const results = [];
    for (const meta of enabledMeta) {
        const entry = await dbGet(`${avatarId}::${meta.filename}`);
        if (entry?.blob) {
            const dataUrl = await blobToDataURL(entry.blob);
            if (dataUrl) {
                results.push({ filename: meta.filename, dataUrl, label: meta.label || '' });
            }
        }
    }
    return results;
}

/** Fetch an image URL (for avatars) and convert to base64. */
async function urlToBase64(url) {
    try {
        const response = await fetch(url, { cache: 'force-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await blobToDataURL(await response.blob());
    } catch (err) {
        console.warn('[Picture Prompt] Failed to fetch image:', url, err);
        return null;
    }
}

function findMessageTarget(chat) {
    const system = chat.find(m => m.role === 'system');
    if (system) return system;
    return chat.find(m => m.role === 'user') || chat[0];
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
            const base64Data = await urlToBase64(url);
            if (base64Data) {
                const label = resolveLabel(s.labelChar);
                if (label) getFirstTextBlock(msg).text += '\n' + label;
                msg.content.push({ type: 'image_url', image_url: { url: base64Data, detail: quality } });
            } else {
                warnOnce('char-fetch', 'Failed to load character avatar image');
            }
        } else {
            warnOnce('char-missing', 'No character avatar set. Set one in the character panel.');
        }
    }

    // Character gallery extras — controlled by its own setting, independent of avatar injection
    if (s.charExtraImagesEnabled) {
        await injectCharGalleryImages(msg, quality);
    }

    // Lorebook images — images from triggered world info entries
    if (s.lorebookImagesEnabled) {
        await injectLorebookImages(msg, quality);
    }

    // Inject persona avatar
    if (s.injectTarget === 'persona' || s.injectTarget === 'both') {
        const url = getPersonaAvatarUrl();
        if (url) {
            const base64Data = await urlToBase64(url);
            if (base64Data) {
                const label = resolveLabel(s.labelUser);
                if (label) getFirstTextBlock(msg).text += '\n' + label;
                msg.content.push({ type: 'image_url', image_url: { url: base64Data, detail: quality } });
            } else {
                warnOnce('persona-fetch', 'Failed to load persona avatar image');
            }
        } else {
            warnOnce('persona-missing', 'No persona avatar set. Set one in the persona panel.');
        }
    }

    // Persona extra images — controlled by its own setting, independent of avatar injection
    if (s.extraImagesEnabled && user_avatar) {
        const extras = await getExtraImagesForInjection(user_avatar);
        for (const img of extras) {
            const perImageLabel = (img.label || '').trim();
            if (perImageLabel) {
                msg.content.push({ type: 'text', text: '\n' + perImageLabel });
            }
            msg.content.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: quality } });
        }
    }
}

/**
 * Fetch enabled character gallery images and inject them into the prompt.
 * @param {object} msg - the target message with content array
 * @param {string} quality - image detail level
 */
async function injectCharGalleryImages(msg, quality) {
    const chId = Number(this_chid);
    if (chId < 0 || !characters?.[chId]?.avatar) return;

    const avatarId = characters[chId].avatar;
    const meta = getCharGalleryMeta(avatarId);
    const enabledFilenames = Object.entries(meta)
        .filter(([, v]) => v.enabled)
        .map(([k]) => k);

    if (!enabledFilenames.length) return;

    const folder = getCharGalleryFolder();
    if (!folder) return;

    const maxCount = getSettings().charExtraImagesMax || 8;
    const toInject = enabledFilenames.slice(0, maxCount);

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

export async function activate() {
    getSettings();
    await addSettingsUI();
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.on(event_types.PERSONA_CHANGED, onPersonaChanged);
    eventSource.on(event_types.CHAT_CHANGED, () => refreshTokenEstimate());
    eventSource.on(event_types.SETTINGS_UPDATED, () => refreshTokenEstimate());
    startPersonaPanelWatcher();
    startGalleryWatcher();
    initLorebookUI();
    initLorebookInject();

    // ── Early-visible 'calculating...' hooks ─────────────────────
    // ST's event system fires late — these bridge the visual gap by
    // showing 'calculating...' before the real estimate runs.

    // Chat block clicks (chat switcher)
    $(document).on('click', '.select_chat_block', (e) => {
        if ($(e.target).closest('.PastChat_cross, .exportRawChatButton, .exportChatButton, .renameChatButton').length) return;
        showCalculating();
    });

    // Persona dropdown changes — fires before PERSONA_CHANGED event
    if (typeof MutationObserver !== 'undefined') {
        const personaObs = new MutationObserver(() => showCalculating());
        // Observe after a short delay — the dropdown may not be in DOM yet
        const tryObservePersona = () => {
            const $dd = $('#persona-management-dropdown');
            if ($dd.length) {
                personaObs.observe($dd[0], { subtree: true, childList: true, characterData: true });
            } else {
                setTimeout(tryObservePersona, 200);
            }
        };
        setTimeout(tryObservePersona, 100);
    }

    console.debug('[Picture Prompt] Activated');
    refreshTokenEstimate();
}
