/**
 * gallery-images.js — Character gallery image injection UI.
 *
 * Handles gallery metadata, label editing overlays, inject-mode
 * button, and thumbnail overlays for the built-in ST gallery.
 *
 * @module gallery-images
 */

import { getContext } from '../../../../extensions.js';
import { characters, this_chid } from '../../../../../script.js';
import { SEL } from './selectors.js';
import { escapeHtml } from './storage.js';
import { moduleName, getSettings } from './settings.js';

// ── Module State ──────────────────────────

let _pp_injectModeActive = false;
let _pp_galleryObserver = null;

export function isInjectModeActive() { return _pp_injectModeActive; }

// ── Gallery Metadata ──────────────────────

/**
 * Get gallery image selections for a character from settings.
 */
export function getCharGalleryMeta(avatarId) {
    const context = getContext();
    const all = context.extensionSettings[moduleName]?.characterGalleryImages;
    if (!all || !all[avatarId]) return {};
    return { ...all[avatarId] };
}

export function setCharGalleryMeta(avatarId, obj) {
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
 */
export function toggleCharGalleryImage(filename) {
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
    applyCharGallerySelections();
}

/**
 * Set the label for a gallery image.
 */
export function setCharGalleryImageLabel(filename, labelText) {
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
 */
export function getCharGalleryFolder() {
    const chId = Number(this_chid);
    if (chId < 0 || !characters?.[chId]) return null;
    const char = characters[chId];
    const context = getContext();
    const customFolder = context.extensionSettings?.gallery?.folders?.[char.avatar];
    return customFolder || char.name;
}

/** Apply/refresh selection visual class on gallery thumbnails. */
export function applyCharGallerySelections() {
    const chId = Number(this_chid);
    if (chId < 0 || !characters?.[chId]?.avatar) return;
    const avatarId = characters[chId].avatar;
    const meta = getCharGalleryMeta(avatarId);

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

// ── Gallery Label Overlay ─────────────────

/** Attach gradient label overlay + 🏷 button to gallery thumbnails. */
export function attachGalleryLabelButtons() {
    const gallery = document.querySelector(SEL.dragGallery);
    if (!gallery) return;
    if (gallery._pp_labelHandlerAttached) return;

    let _currentThumb = null;
    let _editing = false;

    let $btn = $('.pp-gallery-label-btn');
    if (!$btn.length) {
        $btn = $(`<div class="pp-gallery-label-btn" title="Edit label">🏷</div>`);
        $('body').append($btn);
    }

    let $overlay = $('.pp-gallery-label-overlay');
    if (!$overlay.length) {
        $overlay = $('<div class="pp-gallery-label-overlay"></div>');
        $('body').append($overlay);
    }

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
            if (ev.key === 'Enter') { ev.preventDefault(); saveLabel(); }
            else if (ev.key === 'Escape') {
                $overlay.removeClass('pp-editing');
                $overlay.text(meta[filename]?.label || '');
                _editing = false;
            }
        });
    }

    $btn.off('click').on('click', function (e) { e.stopPropagation(); e.preventDefault(); startLabelEdit(); });
    $overlay.off('dblclick').on('dblclick', function (e) { e.stopPropagation(); e.preventDefault(); startLabelEdit(); });

    gallery.addEventListener('mouseenter', function onEnter(e) {
        const thumb = e.target.closest(SEL.galleryThumbnail);
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

        $btn.css({ top: (rect.top + 4) + 'px', left: (rect.left + 4) + 'px' });
        $btn.addClass('visible');
    }, true);

    gallery.addEventListener('mouseleave', function onLeave() {
        setTimeout(() => {
            if (_editing) return;
            const hovered = gallery.querySelector(SEL.galleryThumbnail + ':hover');
            if (!hovered) {
                $overlay.removeClass('visible');
                $btn.removeClass('visible');
                _currentThumb = null;
            }
        }, 50);
    }, true);

    gallery._pp_labelHandlerAttached = true;
}

// ── Gallery DOM Watchers ──────────────────

export function observeGallery($moving) {
    _pp_galleryObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.id === 'gallery') onGalleryOpened();
            }
            for (const node of m.removedNodes) {
                if (node.id === 'gallery') onGalleryClosed();
            }
        }
    });
    _pp_galleryObserver.observe($moving, { childList: true });
}

export function onGalleryClosed() {
    _pp_injectModeActive = false;

    document.querySelectorAll(SEL.injectOverlay).forEach(el => el.remove());
    document.querySelectorAll(SEL.galleryLabelOverlay + ', ' + SEL.galleryLabelBtn).forEach(el => el.remove());

    const gallery = document.querySelector(SEL.gallery);
    if (gallery) gallery.classList.remove('pp-inject-active');

    const dragGallery = document.querySelector(SEL.dragGallery);
    if (dragGallery) {
        if (dragGallery._pp_contentObserver) {
            dragGallery._pp_contentObserver.disconnect();
            delete dragGallery._pp_contentObserver;
        }
        delete dragGallery._pp_labelHandlerAttached;
    }
}

export function onGalleryOpened() {
    console.debug('[Picture Prompt] Gallery opened — injecting inject mode button');

    setTimeout(() => {
        injectInjectButtonIntoGallery();
        setTimeout(() => {
            applyCharGallerySelections();
            attachGalleryLabelButtons();
            if (_pp_injectModeActive) placeInjectOverlays();
            watchGalleryContent();
        }, 300);
    }, 100);
}

/** Find the gallery's topBarElement and inject the Inject button. */
function injectInjectButtonIntoGallery() {
    const $gallery = $('#gallery');
    if (!$gallery.length) return;
    const $deleteBtn = $gallery.find('.right_menu_button.fa-trash');
    if (!$deleteBtn.length) return;
    if ($gallery.find('.pp-gallery-inject-btn').length) return;

    const $injectBtn = $(`<div class="right_menu_button pp-gallery-inject-btn" title="Inject mode">𖡡</div>`);
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

export function toggleInjectOverlays(active) {
    const gallery = document.querySelector(SEL.gallery);
    if (!gallery) return;

    if (active) {
        gallery.classList.add('pp-inject-active');
        placeInjectOverlays();
    } else {
        gallery.classList.remove('pp-inject-active');
        document.querySelectorAll(SEL.injectOverlay).forEach(el => el.remove());
    }
}

function placeInjectOverlays() {
    const gallery = document.querySelector(SEL.gallery);
    if (!gallery) return;

    document.querySelectorAll(SEL.injectOverlay).forEach(el => el.remove());

    const thumbs = gallery.querySelectorAll(SEL.galleryThumbnail);
    if (!thumbs.length) return;

    const subGallery = gallery.querySelector(SEL.gallerySub) || gallery.querySelector(SEL.galleryMain);
    if (!subGallery) return;

    const galleryRect = gallery.getBoundingClientRect();

    thumbs.forEach(thumb => {
        const rect = thumb.getBoundingClientRect();
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

export function watchGalleryContent() {
    const gallery = document.querySelector(SEL.dragGallery);
    if (!gallery || gallery._pp_contentObserver) return;

    const observer = new MutationObserver(() => {
        setTimeout(() => {
            applyCharGallerySelections();
            attachGalleryLabelButtons();
            if (_pp_injectModeActive) placeInjectOverlays();
        }, 50);
    });

    observer.observe(gallery, { childList: true, subtree: true });
    gallery._pp_contentObserver = observer;
}

// ── Cleanup ───────────────────────────────

export function disconnectGalleryObserver() {
    _pp_galleryObserver?.disconnect();
    _pp_galleryObserver = null;
}
