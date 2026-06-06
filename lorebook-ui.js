/**
 * lorebook-ui.js — PicturePrompt lorebook image section UI.
 *
 * Injects a collapsible image grid into world info entry editors.
 * Follows the same .inline-drawer / .picture-prompt-image-card patterns
 * as the persona extra images section.
 *
 * @module lorebook-ui
 */

import {
    getLorebookImage,
    putLorebookImage,
    deleteLorebookImage as deleteLorebookImageDb,
    getLorebookImages,
    addLorebookImage as addLorebookImageMeta,
    removeLorebookImage as removeLorebookImageMeta,
    toggleLorebookImage as toggleLorebookImageMeta,
    updateLorebookImageLabel,
    ensureLIMeta,
    escapeHtml,
} from './lorebook-images.js';
// ── Module Name ───────────────────────────────

const moduleName = 'picture_prompt';

// ── World Name Extraction ─────────────────────

/**
 * Get the currently active world/lorebook name from the editor UI.
 * @returns {string|null}
 */
function getActiveWorldName() {
    const $select = $('#world_editor_select');
    if ($select.length) {
        const text = $select.find(':selected').text();
        if (text && text.trim()) return text.trim();
    }
    // Fallback: look for a visible world info panel tab
    const $tab = $('.world_info_name, .world_info_title').first();
    if ($tab.length) return $tab.text().trim();
    return null;
}

// ── Image Grid Rendering ──────────────────────

/**
 * Render the image grid for a lorebook entry.
 * @param {HTMLElement|jQuery} container - the .inline-drawer-content element
 * @param {string} worldName
 * @param {string|number} entryUid
 * @param {Array} images - array of {filename, label, objectUrl, enabled}
 */
export function renderLorebookImageGrid(container, worldName, entryUid, images) {
    const $container = $(container);
    const $grid = $container.find('.pp-lorebook-grid');
    const $empty = $container.find('.pp-lorebook-empty');
    // .pp-li-count is in the header (sibling of content), not inside content
    const $count = $container.closest('.pp-lorebook-images').find('.pp-li-count');

    // Update count
    if ($count.length) {
        $count.text(images.length);
    }

    if (!images || images.length === 0) {
        if ($grid.length) $grid.empty().hide();
        if ($empty.length) $empty.show();
        return;
    }

    if ($empty.length) $empty.hide();
    if ($grid.length) {
        $grid.show();
    } else {
        console.debug('[PP-Lorebook] Grid element not found, cannot render');
        return;
    }

    $grid.empty();

    for (const img of images) {
        const $card = $(`
            <div class="picture-prompt-image-card" data-filename="${escapeHtml(img.filename)}">
                <div class="card-image-wrap">
                    <img src="${img.objectUrl || ''}" alt="${escapeHtml(img.filename)}" loading="lazy">
                    <div class="card-label-overlay pp-label-edit" title="Double-click to edit label">${escapeHtml(img.label || img.filename)}</div>
                </div>
                <div class="card-body">
                    <div class="card-actions">
                        <label class="pp-img-toggle-label" title="Include in prompt injection">
                            <input type="checkbox" class="pp-img-toggle" data-filename="${escapeHtml(img.filename)}" ${img.enabled !== false ? 'checked' : ''}>
                            <span class="pp-toggle-on">On</span>
                            <span class="pp-toggle-off">Off</span>
                        </label>
                        <button type="button" class="menu_button btn-edit-label" data-filename="${escapeHtml(img.filename)}" title="Edit image label">
                            🏷
                        </button>
                        <button type="button" class="menu_button btn-delete" data-filename="${escapeHtml(img.filename)}" title="Delete this image">
                            🗑️
                        </button>
                    </div>
                </div>
            </div>
        `);
        $grid.append($card);
    }

    // ── Delete handler ──
    $grid.find('.btn-delete').off('click').on('click', function () {
        const filename = $(this).data('filename');
        if (!confirm(`Delete "${filename}"?`)) return;
        deleteLorebookImage(worldName, entryUid, filename);
    });

    // ── Toggle handler ──
    $grid.find('.pp-img-toggle').off('change').on('change', function () {
        const filename = $(this).data('filename');
        toggleLorebookImageMeta(worldName, entryUid, filename);
    });

    // ── Inline label editing ──
    function startLabelEdit($overlay) {
        if ($overlay.find('input').length) return; // already editing
        const currentText = $overlay.text();
        $overlay.data('pp-original-label', currentText);
        $overlay.addClass('pp-editing');
        $overlay.html(`<input type="text" class="pp-label-input" value="${escapeHtml(currentText)}">`);
        const $input = $overlay.find('input');
        $input.focus().select();
    }

    $grid.find('.btn-edit-label').off('click').on('click', function () {
        const $card = $(this).closest('.picture-prompt-image-card');
        const $overlay = $card.find('.pp-label-edit');
        startLabelEdit($overlay);
    });

    $grid.off('dblclick', '.pp-label-edit').on('dblclick', '.pp-label-edit', function () {
        startLabelEdit($(this));
    });

    // Blur / Enter to save
    $grid.off('blur', '.pp-label-input').on('blur', '.pp-label-input', function () {
        const $input = $(this);
        const $overlay = $input.parent();
        const $card = $overlay.closest('.picture-prompt-image-card');
        const filename = $card.data('filename');
        const newLabel = $input.val().trim();
        updateLorebookImageLabel(worldName, entryUid, filename, newLabel);
        const displayText = newLabel || filename;
        $overlay.removeClass('pp-editing').text(displayText);
    });

    $grid.off('keydown', '.pp-label-input').on('keydown', '.pp-label-input', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            $(this).trigger('blur');
        } else if (e.key === 'Escape') {
            e.preventDefault();
            const $input = $(this);
            const $overlay = $input.parent();
            const originalText = $overlay.data('pp-original-label') || '';
            $overlay.removeClass('pp-editing').text(originalText);
        }
    });
}

// ── Section Factory ────────────────────────────

/**
 * Inject (or re-inject) the full lorebook image section into an outlet.
 * @param {HTMLElement|jQuery} outlet - the .inline-drawer-outlet element
 * @param {string} worldName
 * @param {string|number} entryUid
 */
export function injectLorebookSection(outlet, worldName, entryUid) {
    const $outlet = $(outlet);
    if (!$outlet.length) {
        console.debug('[PP-Lorebook] No outlet to inject into');
        return;
    }

    // Don't inject twice
    if ($outlet.find('.pp-lorebook-images').length) {
        console.debug('[PP-Lorebook] Section already injected for this outlet, refreshing');
        refreshLorebookSection(worldName, entryUid);
        return;
    }

    console.debug('[PP-Lorebook] Injecting lorebook image section for entry', entryUid, 'world', worldName);

    const sectionHtml = `
        <div class="pp-lorebook-images" data-entry-uid="${escapeHtml(String(entryUid))}" data-world-name="${escapeHtml(worldName)}">
            <div class="inline-drawer wide100p flexFlowColumn">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Lorebook Images (<span class="pp-li-count">0</span>)</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="flex-container marginTopBot5">
                        <button type="button" class="menu_button pp-lorebook-upload-btn" title="Add an image for this lorebook entry">
                            <i class="fa-solid fa-upload margin0"></i> + Add Image
                        </button>
                        <input type="file" class="pp-lorebook-file-input" hidden accept="image/*">
                    </div>
                    <div class="pp-lorebook-grid picture-prompt-images-grid" style="margin-top: 0.5rem;"></div>
                    <div class="pp-lorebook-empty" style="margin-top: 0.5em; color: var(--text-color-dim); font-size: 0.85em;">
                        No images for this lorebook entry yet.
                    </div>
                </div>
            </div>
        </div>
    `;

    // Insert before the "Additional Matching Sources" drawer
    const $additionalSources = $outlet.find('.inline-drawer').filter(function () {
        return $(this).find('strong').text().includes('Additional Matching Sources');
    }).first();
    if ($additionalSources.length) {
        $additionalSources.before(sectionHtml);
    } else {
        // Fallback: before the last .inline-drawer, or append if none found
        const $lastDrawer = $outlet.find('.inline-drawer').last();
        if ($lastDrawer.length) {
            $lastDrawer.before(sectionHtml);
        } else {
            $outlet.append(sectionHtml);
        }
    }

    // ── Upload button handler ──
    const $section = $outlet.find('.pp-lorebook-images').last();
    const $uploadBtn = $section.find('.pp-lorebook-upload-btn');
    const $fileInput = $section.find('.pp-lorebook-file-input');

    $uploadBtn.on('click', function () {
        $fileInput.trigger('click');
    });

    $fileInput.on('change', function () {
        const files = this.files;
        if (!files || files.length === 0) return;
        uploadLorebookImage(worldName, entryUid, files[0]);
        $(this).val('');
    });

    // Load and render existing images
    refreshLorebookSection(worldName, entryUid);
}

// ── Section Refresh ────────────────────────────

/**
 * Re-read entry metadata and re-render the image grid.
 * @param {string} worldName
 * @param {string|number} entryUid
 */
export function refreshLorebookSection(worldName, entryUid) {
    const $section = $(`.pp-lorebook-images[data-entry-uid="${escapeHtml(String(entryUid))}"][data-world-name="${escapeHtml(worldName)}"]`);
    if (!$section.length) {
        console.debug('[PP-Lorebook] refresh: section NOT FOUND for entryUid=', entryUid, 'worldName=', worldName);
        return;
    }

    const $content = $section.find('.inline-drawer-content');
    const $grid = $content.find('.pp-lorebook-grid');
    const $empty = $content.find('.pp-lorebook-empty');

    if (!$grid.length) {
        console.debug('[PP-Lorebook] Grid element not found in section');
        return;
    }

    const metaList = getLorebookImages(worldName, entryUid);
    console.debug('[PP-Lorebook] refresh: worldName=', worldName, 'entryUid=', entryUid, 'images count:', metaList.length);

    if (metaList.length === 0) {
        if ($grid.length) $grid.empty().hide();
        if ($empty.length) $empty.show();
        const $count = $section.find('.pp-li-count');
        if ($count.length) $count.text('0');
        return;
    }

    // Fetch blobs from IndexedDB and build object URLs
    loadImagesForGrid(worldName, entryUid, metaList);
}

/**
 * Fetch image blobs from IndexedDB and render the grid.
 * @param {string} worldName
 * @param {string|number} entryUid
 * @param {Array} metaList
 */
async function loadImagesForGrid(worldName, entryUid, metaList) {
    const $section = $(`.pp-lorebook-images[data-entry-uid="${escapeHtml(String(entryUid))}"][data-world-name="${escapeHtml(worldName)}"]`);
    if (!$section.length) return;

    const $content = $section.find('.inline-drawer-content');
    const $grid = $content.find('.pp-lorebook-grid');
    const $empty = $content.find('.pp-lorebook-empty');

    if (!$grid.length) return;

    // Revoke old blob URLs before replacing grid content
    $grid.find('img[src^="blob:"]').each(function () {
        URL.revokeObjectURL(this.src);
    });
    $grid.html('<span style="font-size:0.85em; color: var(--text-color-dim);">Loading...</span>');
    $grid.show();
    if ($empty.length) $empty.hide();

    try {
        console.debug('[PP-Lorebook] loadImagesForGrid: looking up', metaList.length, 'images for', worldName, entryUid);
        const images = [];
        for (const meta of metaList) {
            const entry = await getLorebookImage(worldName, entryUid, meta.filename);
            if (entry && entry.blob) {
                const objUrl = URL.createObjectURL(entry.blob);
                images.push({ ...meta, objectUrl: objUrl });
            } else {
                console.debug('[PP-Lorebook] Blob not found for', `${worldName}::${entryUid}::${meta.filename}`);
            }
        }

        renderLorebookImageGrid($content, worldName, entryUid, images);

        if (images.length === 0) {
            $grid.hide();
            if ($empty.length) $empty.show();
        }
    } catch (err) {
        console.error('[PP-Lorebook] Failed to load images:', err);
        $grid.html('<span style="font-size:0.85em; color: #e55;">Failed to load images</span>');
    }
}

// ── Upload / Delete ────────────────────────────

/**
 * Upload a single image for a lorebook entry.
 * @param {string} worldName
 * @param {string|number} entryUid
 * @param {File} file
 */
async function uploadLorebookImage(worldName, entryUid, file) {
    if (!file) return;

    // Validate image type
    if (!/\.(jpg|jpeg|png|gif|webp|bmp|apng|tif|tiff)$/i.test(file.name)) {
        toastr.warning(`"${file.name}" is not a supported image type.`);
        return;
    }

    try {
        const base = file.name.replace(/\.[^.]+$/, '');
        const ext = (file.name.match(/\.[^.]+$/) || ['.png'])[0];
        const filename = `${base}_${Date.now()}${ext}`;

        const blob = new Blob([await file.arrayBuffer()], { type: file.type });

        // Default label: use "Entry Title:" if set, otherwise cleaned filename
        let label = '';
        const $section = $(`.pp-lorebook-images[data-entry-uid="${escapeHtml(String(entryUid))}"]`);
        if ($section.length) {
            const comment = $section.closest('.world_entry').find('textarea[name="comment"]').val()?.trim();
            label = comment ? comment + ':' : base.replace(/[_-]/g, ' ');
        } else {
            label = base.replace(/[_-]/g, ' ');
        }

        await putLorebookImage(worldName, entryUid, filename, blob, label);

        // Save metadata to extension_settings (survives ST's entry editor saves)
        addLorebookImageMeta(worldName, entryUid, filename, label);

        toastr.success(`Uploaded "${filename}"`);
        refreshLorebookSection(worldName, entryUid);
    } catch (err) {
        console.error('[PP-Lorebook] Upload failed:', err);
        toastr.error('Upload failed. Check console for details.');
    }
}

// Debug helper — call from console: PP_Lorebook.debug()
window.PP_Lorebook = {
    debug() {
        const meta = ensureLIMeta();
        const keys = Object.keys(meta);
        console.log('[PP-Lorebook] lorebookImages metadata keys:', keys);
        for (const k of keys) {
            console.log(`[PP-Lorebook]   ${k}: ${meta[k].length} image(s)`);
        }
        toastr.info(`lorebookImages has ${keys.length} entries: ${keys.join(', ') || '(none)'}`, 'PP Debug');
    }
};

/**
 * Delete a single image for a lorebook entry.
 * @param {string} worldName
 * @param {string|number} entryUid
 * @param {string} filename
 */
async function deleteLorebookImage(worldName, entryUid, filename) {
    try {
        await deleteLorebookImageDb(worldName, entryUid, filename);

        // Remove from metadata
        removeLorebookImageMeta(worldName, entryUid, filename);

        // Revoke any object URLs for this image
        const $card = $(`.pp-lorebook-images[data-entry-uid="${escapeHtml(String(entryUid))}"] .picture-prompt-image-card[data-filename="${escapeHtml(filename)}"]`);
        if ($card.length) {
            const $img = $card.find('img');
            if ($img.length && $img.attr('src')?.startsWith('blob:')) {
                URL.revokeObjectURL($img.attr('src'));
            }
        }

        toastr.success('Image deleted');
        refreshLorebookSection(worldName, entryUid);
    } catch (err) {
        console.error('[PP-Lorebook] Delete failed:', err);
        toastr.error('Delete failed. Check console for details.');
    }
}

// ── Mutation Observer ──────────────────────────

let _lorebookObserver = null;
let _lorebookScanInterval = null;

/**
 * Start watching for world info entry editors being opened.
 * Injects the lorebook image section when a drawer opens.
 */
export function initLorebookUI() {
    if (_lorebookObserver) {
        console.debug('[PP-Lorebook] Observer already running');
        return;
    }

    console.debug('[PP-Lorebook] Initializing lorebook UI observer');

    // If world info panel isn't in DOM yet, retry
    if (!document.getElementById('world_popup_entries_list')) {
        console.debug('[PP-Lorebook] World info panel not yet in DOM, retrying in 2s');
        setTimeout(initLorebookUI, 2000);
        return;
    }

    _lorebookObserver = new MutationObserver(function (mutations) {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (!(node instanceof Element)) continue;

                // Check if any added node contains, is, or is inside an inline-drawer-outlet
                const $outlets = $(node).is('.inline-drawer-outlet')
                    ? $(node)
                    : ($(node).find('.inline-drawer-outlet').length
                        ? $(node).find('.inline-drawer-outlet')
                        : $(node).closest('.inline-drawer-outlet'));

                $outlets.each(function () {
                    const $outlet = $(this);
                    const $worldEntry = $outlet.closest('.world_entry');
                    if (!$worldEntry.length) {
                        console.debug('[PP-Lorebook] Found outlet not inside a .world_entry, skipping');
                        return;
                    }

                    // Already have our section?
                    if ($outlet.find('.pp-lorebook-images').length) {
                        return;
                    }

                    // Only inject if editor content is present (drawer is open)
                    if (!$outlet.find('.world_entry_edit').length) {
                        return;
                    }

                    const entryUid = $worldEntry.data('uid');
                    if (entryUid === undefined || entryUid === null || entryUid === '') {
                        console.debug('[PP-Lorebook] No UID on .world_entry, trying .world_entry_form_uid_value');
                        const uidText = $worldEntry.find('.world_entry_form_uid_value').text().trim();
                        const uidMatch = uidText.match(/UID:\s*(\d+)/i);
                        if (!uidMatch) {
                            console.debug('[PP-Lorebook] Could not extract UID');
                            return;
                        }
                        // We need a numeric UID — use the matched number
                        const uid = uidMatch[1];
                        injectIfReady($outlet, uid);
                    } else {
                        injectIfReady($outlet, entryUid);
                    }
                });
            }
        }
    });

    _lorebookObserver.observe(document.body, { childList: true, subtree: true });

    // Also scan any already-open editors
    scanExistingEditors();

    // Re-scan periodically to catch editors that may have been missed
    // (some drawer content is populated asynchronously)
    _lorebookScanInterval = setInterval(scanExistingEditors, 3000);
}

/**
 * Scan for existing open editors and inject sections if not already present.
 */
function scanExistingEditors() {
    const $outlets = $('.world_entry .inline-drawer-outlet:visible');
    $outlets.each(function () {
        const $outlet = $(this);
        if ($outlet.find('.pp-lorebook-images').length) return;

        const $worldEntry = $outlet.closest('.world_entry');
        if (!$worldEntry.length) return;

        const entryUid = $worldEntry.data('uid');
        if (entryUid === undefined || entryUid === null || entryUid === '') {
            const uidText = $worldEntry.find('.world_entry_form_uid_value').text().trim();
            const uidMatch = uidText.match(/UID:\s*(\d+)/i);
            if (!uidMatch) return;
            injectIfReady($outlet, uidMatch[1]);
        } else {
            injectIfReady($outlet, entryUid);
        }
    });
}

/**
 * Check if we can inject the lorebook section and do so.
 */
function injectIfReady($outlet, entryUid) {
    const worldName = getActiveWorldName();
    if (!worldName) {
        console.debug('[PP-Lorebook] No active world name found, cannot inject');
        return;
    }

    // Wait a tick for the drawer content to finish rendering
    setTimeout(() => {
        injectLorebookSection($outlet, worldName, entryUid);
    }, 100);
}

// ── Styles ─────────────────────────────────────

/**
 * Inject required styles for the lorebook section into the page.
 */
function injectStyles() {
    if (document.getElementById('pp-lorebook-styles')) return;

    const style = document.createElement('style');
    style.id = 'pp-lorebook-styles';
    style.textContent = `
        .pp-lorebook-images {
            margin-top: 0.5rem;
            width: 100%;
        }
        .pp-lorebook-images .inline-drawer-content {
            padding-top: 0.5rem;
        }
        .pp-lorebook-images .card-actions .btn-delete {
            color: #e55;
            border-color: #e55;
        }
    `;
    document.head.appendChild(style);
}

// Inject styles on module load
injectStyles();
