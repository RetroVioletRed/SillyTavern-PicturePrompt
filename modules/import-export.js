/**
 * import-export.js — Export/import Picture Prompt image data as ZIP.
 *
 * EXPORT: gathers all IndexedDB blobs + extension_settings into a zip,
 *         triggers browser download.
 * IMPORT: reads a zip, replaces IDB store + settings atomically,
 *         with a confirmation dialog.
 *
 * @module import-export
 */

import { openDB, STORE_NAME, log } from './storage.js';
import { getSettings, moduleName } from './settings.js';
import { clearFetchCache } from './lorebook-images.js';
import { getContext } from '../../../../extensions.js';

// ── Export ──────────────────────────────

/**
 * Export all image data and settings as a downloadable ZIP file.
 *
 * ZIP structure:
 *   manifest.json   — { formatVersion, exportedAt, recordCount }
 *   settings.json   — full extension_settings.picture_prompt
 *   images/{key}    — raw blob for each IndexedDB record
 *
 * @returns {Promise<void>}
 */
export async function exportImageData() {
    // 1. Gather all IndexedDB records
    const db = await openDB();
    const records = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

    // 2. Load JSZip (side-effect import — sets window.JSZip)
    await import('../../../../../lib/jszip.min.js');
    const JSZip = window.JSZip;
    if (!JSZip) throw new Error('JSZip failed to load');

    // 3. Build zip
    const zip = new JSZip();

    zip.file('manifest.json', JSON.stringify({
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        recordCount: records.length,
    }, null, 2));

    const settings = getSettings();
    zip.file('settings.json', JSON.stringify(settings, null, 2));

    const imagesFolder = zip.folder('images');
    for (const record of records) {
        if (record && record.id && record.blob) {
            imagesFolder.file(record.id, record.blob);
        }
    }

    // 4. Generate zip blob and trigger download
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `picture-prompt-export-${date}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    log.debug(`Exported ${records.length} images`);
    toastr.success(`Exported ${records.length} images`);
}

// ── Import ──────────────────────────────

/**
 * Import image data and settings from a ZIP file.
 *
 * Replaces all existing IndexedDB records and extension_settings
 * atomically. Shows a confirmation dialog before proceeding.
 *
 * @param {File} file — the .zip file from an <input type="file">
 * @returns {Promise<void>}
 */
export async function importImageData(file) {
    // 1. Load JSZip and parse
    await import('../../../../../lib/jszip.min.js');
    const JSZip = window.JSZip;
    if (!JSZip) throw new Error('JSZip failed to load');

    let zip;
    try {
        zip = await JSZip.loadAsync(file);
    } catch {
        toastr.error('Not a valid Picture Prompt export file.');
        return;
    }

    // 2. Validate manifest
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) {
        toastr.error('Not a valid Picture Prompt export file (missing manifest).');
        return;
    }

    let manifest;
    try {
        manifest = JSON.parse(await manifestFile.async('string'));
    } catch {
        toastr.error('Not a valid Picture Prompt export file (bad manifest).');
        return;
    }

    if (manifest.formatVersion !== 1) {
        toastr.error(`Unsupported export format (version ${manifest.formatVersion}).`);
        return;
    }

    // 3. Read settings and count images
    let importedSettings;
    try {
        const settingsFile = zip.file('settings.json');
        if (settingsFile) {
            importedSettings = JSON.parse(await settingsFile.async('string'));
        }
    } catch {
        toastr.error('Corrupt settings in export file.');
        return;
    }

    // Collect image entries from zip (blob extraction outside IDB transaction)
    const imagesFolder = zip.folder('images');
    const imageFiles = [];
    if (imagesFolder) {
        imagesFolder.forEach((relativePath, file) => {
            if (!file.dir) imageFiles.push({ name: relativePath, file });
        });
    }

    // 4. Confirm
    const date = manifest.exportedAt
        ? new Date(manifest.exportedAt).toLocaleDateString()
        : 'unknown date';
    const message = `This will replace all current image data with the export from ${date} (${imageFiles.length} images). Continue?`;

    const context = getContext();
    const confirmed = await context.Popup.show.confirm('Import Image Data', message);
    if (!confirmed) return;

    // 5. Extract blobs from zip (before IDB transaction)
    const imageEntries = [];
    try {
        for (const { name, file } of imageFiles) {
            const blob = await file.async('blob');
            imageEntries.push({ id: name, blob });
        }
    } catch (err) {
        log.error('Failed to extract images from import file:', err);
        toastr.error('Import failed while reading images. Your data has not been changed.');
        return;
    }

    // 6. Replace IDB store
    try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);

            const clearReq = store.clear();
            clearReq.onsuccess = () => {
                if (imageEntries.length === 0) {
                    resolve();
                    return;
                }
                let remaining = imageEntries.length;
                for (const { id, blob } of imageEntries) {
                    const record = { id, blob, meta: {}, storedAt: Date.now() };
                    const putReq = store.put(record);
                    putReq.onsuccess = () => {
                        if (--remaining === 0) resolve();
                    };
                    putReq.onerror = () => reject(putReq.error);
                }
            };
            clearReq.onerror = () => reject(clearReq.error);
        });
    } catch (err) {
        log.error('Import failed while updating IndexedDB:', err);
        toastr.error('Import failed. Your data has not been changed.');
        return;
    }

    // 7. Replace settings
    if (importedSettings) {
        context.extensionSettings[moduleName] = importedSettings;
        context.saveSettingsDebounced();
    }

    // 8. Clear caches
    clearFetchCache();

    toastr.success(`Imported ${imageEntries.length} images`);
    log.debug(`Imported ${imageEntries.length} images`);
}
