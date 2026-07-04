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
 * Run canvas pipeline for a single file: resize (if requested) + optional WebP conversion.
 * @param {File} file
 * @param {object} settings - extension settings
 * @param {boolean} doResize - whether to scale to maxDimension
 * @param {boolean} doWebp - whether to export as WebP
 * @returns {Promise<Blob>}
 */
async function canvasProcess(file, settings, doResize, doWebp) {
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = () => reject(new Error('Failed to load image for processing'));
            i.src = url;
        });

        let tw = img.naturalWidth;
        let th = img.naturalHeight;

        if (doResize) {
            const scale = settings.preprocessMaxDimension / Math.max(tw, th);
            tw = Math.round(tw * scale);
            th = Math.round(th * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        canvas.getContext('2d').drawImage(img, 0, 0, tw, th);

        const mimeType = doWebp ? 'image/webp' : file.type;
        const quality = doWebp ? settings.preprocessWebpQuality / 100 : 1;

        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (blob) resolve(blob);
                else reject(new Error('Canvas export failed'));
            }, mimeType, quality);
        });
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
            needsResize: r.valid && Math.max(r.width, r.height) > settings.preprocessMaxDimension,
            maxDimension: settings.preprocessMaxDimension,
            webpDefault: settings.preprocessConvertWebp,
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

    // Read toggle state from dialog DOM, process files that need canvas work.
    const results = [];
    for (let i = 0; i < enrichedResults.length; i++) {
        const r = enrichedResults[i];
        if (!r.valid) continue;

        const doResize = template.find(`.pp-prep-resize[data-index="${i}"]`).prop('checked') === true;
        const doWebp = template.find(`.pp-prep-webp[data-index="${i}"]`).prop('checked') === true;

        const blob = (doResize || doWebp)
            ? await canvasProcess(r.file, settings, doResize, doWebp)
            : new Blob([await r.file.arrayBuffer()], { type: r.file.type });

        results.push({ file: r.file, blob });
    }

    return { accepted: true, results };
}
