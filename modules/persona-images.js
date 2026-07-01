/**
 * persona-images.js — Persona extra images panel UI.
 *
 * Injects an "Extra Images" collapsible section into the persona
 * management panel, handles upload/delete/label-edit, and provides
 * the image grid with drag-to-reorder.
 *
 * @module persona-images
 */

import { getContext } from '../../../../extensions.js';
import { user_avatar } from '../../../../../script.js';
import { power_user } from '../../../../power-user.js';
import { SEL } from './selectors.js';
import { escapeHtml, dbPut, dbGet, dbDelete, log } from './storage.js';
import { getSettings, getMetaForPersona, setMetaForPersona } from './settings.js';
import { clearFetchCache, enableGridDragReorder } from './lorebook-images.js';
import { preprocessImage } from './image-preprocess.js';

// ── Module State ──────────────────────────

let _pp_personaPanelObserver = null;
let _pp_panelRendered = false;

// ── Persona Panel DOM Watchers ────────────

/**
 * Attach attributes observer to the persona panel element.
 * Called by startPanelWatchers once #PersonaManagement is found.
 */
export function observePersonaPanel($content) {
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
    } else {
        // Revoke blob URLs when drawer closes (ST removes grid DOM without re-render)
        $('#pp_extra_images_grid').find('img[src^="blob:"]').each(function () {
            URL.revokeObjectURL(this.src);
        });
    }
}

export function renderIfPanelOpen() {
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

// ── Extra Images Section UI ───────────────

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
export async function loadPersonaImagesForPanel(avatarId) {
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
        log.error('Failed to load images:', err);
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

export function onPersonaChanged(avatarId) {
    clearFetchCache();
    const $panel = $('.persona_management_current_persona');
    if (!$panel.length) return;
    renderIfPanelOpen();
}

/** Render images into a grid. */
function renderImageGrid(images, gridSelector = '#pp_extra_images_grid', avatarId = null) {
    const $grid = $(gridSelector);
    $grid.find('img[src^="blob:"]').each(function () {
        URL.revokeObjectURL(this.src);
    });
    $grid.empty();

    if (!images || images.length === 0) {
        $grid.html('<span style="font-size:0.85em; color: var(--text-color-dim);">No extra images uploaded yet.</span>');
        return;
    }

    const targetAvatarId = avatarId || ($('#pp_extra_images_section').data('avatar-id') || '');

    for (const img of images) {
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
        const $card = $(this).closest(SEL.picturePromptImageCard);
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

    enableGridDragReorder(gridSelector,
        () => getMetaForPersona(targetAvatarId),
        (arr) => setMetaForPersona(targetAvatarId, arr));
}

// ── Inline Label Editing ──────────────────

function startLabelEdit($overlay) {
    if ($overlay.find('input').length) return;
    const currentText = $overlay.text();
    $overlay.data('pp-original-label', currentText);
    $overlay.addClass('pp-editing');
    $overlay.html(`<input type="text" class="pp-label-input" value="${escapeHtml(currentText)}">`);
    const $input = $overlay.find('input');
    $input.focus().select();
}

function commitLabelEdit(avatarId, $input) {
    const $overlay = $input.parent();
    const filename = $overlay.closest(SEL.picturePromptImageCard).data('filename');
    const newLabel = $input.val().trim();

    const metaList = getMetaForPersona(avatarId);
    const entry = metaList.find(m => m.filename === filename);
    if (entry) {
        entry.label = newLabel;
        setMetaForPersona(avatarId, metaList);
    }

    const displayText = newLabel || filename;
    $overlay.removeClass('pp-editing').text(displayText);
}

function cancelLabelEdit($input) {
    const $overlay = $input.parent();
    const originalText = $overlay.data('pp-original-label') || '';
    $overlay.removeClass('pp-editing').text(originalText);
}

// ── Upload / Delete ───────────────────────

async function uploadExtraImages(avatarId, files) {
    const settings = getSettings();
    const maxImages = Number.isFinite(settings.maxExtraImages) ? Math.max(0, settings.maxExtraImages) : 8;

    try {
        const existing = getMetaForPersona(avatarId);
        const currentCount = existing.length;
        const remaining = maxImages - currentCount;

        if (remaining <= 0) {
            toastr.warning(`Maximum of ${maxImages} extra images reached for this persona.`);
            return;
        }

        // Pass all files to preprocessing — dialog shows validation status for every file.
        const { accepted, results } = await preprocessImage(Array.from(files), settings);
        if (!accepted) return;

        // Cap to remaining slots.
        const toStore = results.slice(0, remaining);
        if (toStore.length < results.length) {
            toastr.warning(`Only uploading ${toStore.length} of ${results.length} — limit is ${maxImages} images.`);
        }
        if (toStore.length === 0) return;

        let acceptedCount = 0;
        for (const { file, blob } of toStore) {
            acceptedCount++;

            const base = file.name.replace(/\.[^.]+$/, '');
            const ext = (file.name.match(/\.[^.]+$/) || ['.png'])[0];
            const filename = `${base}_${Date.now()}${ext}`;

            const id = `${avatarId}::${filename}`;
            const label = base.replace(/[_-]/g, ' ');

            await dbPut(id, blob, { filename, label });

            const metaList = getMetaForPersona(avatarId);
            metaList.push({ id, filename, label });
            setMetaForPersona(avatarId, metaList);
        }

        if (acceptedCount > 0) {
            toastr.success(`Uploaded ${acceptedCount} image(s)`);
            loadPersonaImagesForPanel(avatarId);
        }
    } catch (err) {
        log.error('Upload failed:', err);
        toastr.error('Upload failed. Check console for details.');
    }
}

async function deleteExtraImage(avatarId, filename) {
    try {
        const id = `${avatarId}::${filename}`;
        await dbDelete(id);

        const metaList = getMetaForPersona(avatarId).filter(m => m.filename !== filename);
        setMetaForPersona(avatarId, metaList);

        toastr.success('Image deleted');
        loadPersonaImagesForPanel(avatarId);
    } catch (err) {
        log.error('Delete failed:', err);
        toastr.error('Delete failed. Check console for details.');
    }
}

// ── Cleanup ───────────────────────────────

export function disconnectPersonaObserver() {
    _pp_personaPanelObserver?.disconnect();
    _pp_personaPanelObserver = null;
}
