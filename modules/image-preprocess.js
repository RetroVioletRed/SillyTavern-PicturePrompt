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
 * Detect whether an image file is animated by inspecting format-specific markers.
 * Reads the first 8KB of the file — animated markers are always in the header.
 * @param {File} file
 * @returns {Promise<{ animated: boolean, warning: string|null }>}
 */
async function detectAnimation(file) {
    const header = new Uint8Array(await file.slice(0, 8192).arrayBuffer());

    // GIF: look for Netscape Application Extension (loop control).
    // Present in virtually all animated GIFs, always within the first few KB.
    if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x38) {
        if (/NETSCAPE2\.0/.test(new TextDecoder().decode(header))) {
            return { animated: true, warning: 'Animation will be lost; only the first frame is kept' };
        }
        return { animated: false, warning: null };
    }

    // PNG: look for acTL chunk (Animation Control).
    if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) {
        if (/acTL/.test(new TextDecoder().decode(header))) {
            return { animated: true, warning: 'Animation will be lost; only the first frame is kept' };
        }
        return { animated: false, warning: null };
    }

    // WebP: look for ANIM fourCC in RIFF container.
    if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) {
        if (/ANIM/.test(new TextDecoder().decode(header))) {
            return { animated: true, warning: 'Animation will be lost; only the first frame is kept' };
        }
        return { animated: false, warning: null };
    }

    return { animated: false, warning: null };
}

/**
 * Read the image via ObjectURL to get dimensions and a preview data URL.
 * The returned URL must be revoked by the caller after the dialog closes.
 * @param {File} file
 * @returns {Promise<{ url: string, width: number, height: number }>}
 */
async function readPreview(file) {
    const url = URL.createObjectURL(file);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ url, width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error('Failed to read preview'));
        img.src = url;
    });
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

    // Animation detection + preview reading for valid files (parallel).
    const enrichedResults = await Promise.all(fileResults.map(async (r) => {
        if (!r.valid) {
            return { ...r, animated: false, warning: null, previewUrl: null, width: null, height: null };
        }
        const [anim, preview] = await Promise.all([
            detectAnimation(r.file),
            readPreview(r.file),
        ]);
        return {
            ...r,
            animated: anim.animated,
            warning: anim.warning,
            previewUrl: preview.url,
            width: preview.width,
            height: preview.height,
        };
    }));

    const templateData = {
        files: enrichedResults.map(r => ({
            name: r.file.name,
            accepted: r.valid,
            reason: r.reason,
            animated: r.animated,
            warning: r.warning,
            previewUrl: r.previewUrl,
            width: r.width,
            height: r.height,
        })),
    };

    const template = $(await renderExtensionTemplateAsync(extDirParts, 'modules/imagePreprocessDialog', templateData, false));

    const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Accept',
        cancelButton: 'Discard',
        onOpen: (popup) => {
            popup.buttonControls.style.flexDirection = 'row-reverse';
        },
    });

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        // Clean up preview object URLs.
        for (const r of enrichedResults) {
            if (r.previewUrl) URL.revokeObjectURL(r.previewUrl);
        }
        return { accepted: false, results: [] };
    }

    // Clean up preview object URLs.
    for (const r of enrichedResults) {
        if (r.previewUrl) URL.revokeObjectURL(r.previewUrl);
    }

    // Read blobs for valid files only.
    const results = await Promise.all(
        enrichedResults
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
