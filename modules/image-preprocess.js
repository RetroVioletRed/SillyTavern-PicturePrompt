/**
 * image-preprocess.js — PicturePrompt image upload preprocessing pipeline.
 *
 * Validates files by actual Image decode, then shows a batch dialog with
 * per-file status before passing accepted blobs to the caller.
 */
import { renderExtensionTemplateAsync } from '../../../../extensions.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';

// Resolve extension directory for template path.
const extDirParts = (() => {
    const parts = new URL(import.meta.url).pathname.split('/').filter(Boolean);
    const idx = parts.lastIndexOf('extensions');
    return parts.slice(idx + 1, -2).join('/');
})();

/** Supported image extensions (lowercase, no dot). */
const SUPPORTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'apng', 'tif', 'tiff'];

/**
 * Validate a single file by checking format, then attempting to decode it.
 * @param {File} file
 * @returns {Promise<{ file: File, valid: boolean, reason: string|null }>}
 */
async function validateFile(file) {
    // 1. Check file extension.
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'svg') {
        return { file, valid: false, reason: 'SVG images are not supported' };
    }
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        return { file, valid: false, reason: `Unsupported format: .${ext}` };
    }

    // 2. Attempt actual image decode.
    const url = URL.createObjectURL(file);
    try {
        await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                if (img.naturalWidth === 0 || img.naturalHeight === 0) {
                    reject(new Error('Invalid or empty image'));
                } else {
                    resolve();
                }
            };
            img.onerror = () => reject(new Error('Corrupted or unreadable'));
            img.src = url;
        });
        return { file, valid: true, reason: null };
    } catch (err) {
        return { file, valid: false, reason: err.message };
    } finally {
        URL.revokeObjectURL(url);
    }
}

/**
 * Validate all files, show batch dialog, return accepted blobs.
 *
 * @param {File[]} files    - Files selected by the user.
 * @param {object} settings - Extension settings (unused in v1, passed for future steps).
 * @returns {Promise<{ accepted: boolean, results: { file: File, blob: Blob }[] }>}
 */
export async function preprocessImage(files, settings) {
    // Validate all files first.
    const fileResults = await Promise.all(files.map(f => validateFile(f)));

    const templateData = {
        files: fileResults.map(r => ({
            name: r.file.name,
            accepted: r.valid,
            reason: r.reason,
        })),
    };

    const template = $(await renderExtensionTemplateAsync(extDirParts, 'imagePreprocessDialog', templateData));

    const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Accept',
        cancelButton: 'Discard',
        onOpen: (popup) => {
            popup.buttonControls.style.flexDirection = 'row-reverse';
        },
    });

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return { accepted: false, results: [] };
    }

    // Read blobs for valid files only.
    const results = await Promise.all(
        fileResults
            .filter(r => r.valid)
            .map(async (r) => {
                const buf = await r.file.arrayBuffer();
                return {
                    file: r.file,
                    blob: new Blob([buf], { type: r.file.type }),
                };
            })
    );

    return { accepted: true, results };
}
