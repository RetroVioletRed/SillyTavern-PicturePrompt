import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

// ── Constants ───────────────────────────

/**
 * IndexedDB database name — shared with the main PicturePrompt extension.
 * @type {string}
 */
const DB_NAME = 'PicturePrompt';

/**
 * IndexedDB database version.
 * @type {number}
 */
const DB_VERSION = 1;

/**
 * Object store name — shared with the main PicturePrompt extension.
 * @type {string}
 */
const STORE_NAME = 'extraImages';

/**
 * Settings namespace within extension_settings.
 * @type {string}
 */
const MODULE_NAME = 'picture_prompt';

/**
 * Default lorebook image settings.
 * @type {{ lorebookImagesEnabled: boolean, lorebookImagesMax: number }}
 */
const DEFAULT_LOREBOOK_SETTINGS = {
    lorebookImagesEnabled: false,
    lorebookImagesMax: 4,
};

// ── IndexedDB Helpers ────────────────────

/**
 * Open (or create) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE_NAME)) {
                req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Build the IndexedDB key for a lorebook image.
 * Pattern: `lorebook::{worldName}::{entryUid}::{filename}`
 * @param {string} worldName
 * @param {string} entryUid
 * @param {string} filename
 * @returns {string}
 */
function lorebookKey(worldName, entryUid, filename) {
    return `lorebook::${worldName}::${entryUid}::${filename}`;
}

/**
 * Build the prefix for listing all images of a lorebook entry.
 * Pattern: `lorebook::{worldName}::{entryUid}::`
 * @param {string} worldName
 * @param {string} entryUid
 * @returns {string}
 */
function lorebookPrefix(worldName, entryUid) {
    return `lorebook::${worldName}::${entryUid}::`;
}

// ── IndexedDB CRUD: Lorebook Images ─────

/**
 * Store (insert or update) a lorebook image blob in IndexedDB.
 *
 * @param {string}   worldName  - Name of the world / lorebook.
 * @param {string}   entryUid   - UID of the world info entry.
 * @param {string}   filename   - Image filename.
 * @param {Blob}     blob       - Image binary data.
 * @param {string}  [label]     - Optional display label.
 * @returns {Promise<void>}
 */
export async function putLorebookImage(worldName, entryUid, filename, blob, label) {
    const id = lorebookKey(worldName, entryUid, filename);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({
            id,
            blob,
            meta: { filename, label: label || '', worldName, entryUid },
            storedAt: Date.now(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Retrieve a lorebook image blob from IndexedDB.
 *
 * Returns `null` if no record exists for the given key.
 *
 * @param {string} worldName
 * @param {string} entryUid
 * @param {string} filename
 * @returns {Promise<{blob: Blob, meta: object}|null>}
 */
export async function getLorebookImage(worldName, entryUid, filename) {
    const id = lorebookKey(worldName, entryUid, filename);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Delete a lorebook image blob from IndexedDB.
 *
 * @param {string} worldName
 * @param {string} entryUid
 * @param {string} filename
 * @returns {Promise<void>}
 */
export async function deleteLorebookImage(worldName, entryUid, filename) {
    const id = lorebookKey(worldName, entryUid, filename);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * List all stored image record IDs for a given lorebook entry.
 *
 * @param {string} worldName
 * @param {string} entryUid
 * @returns {Promise<{id: string, blob: Blob, meta: object}[]>}
 */
export async function listLorebookImages(worldName, entryUid) {
    const prefix = lorebookPrefix(worldName, entryUid);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => {
            resolve((req.result || []).filter(record => record.id.startsWith(prefix)));
        };
        req.onerror = () => reject(req.error);
    });
}

// ── Lorebook Image Metadata (extension_settings) ─

/**
 * Storage key prefix for lorebook image metadata.
 * Stored as `extension_settings.picture_prompt.lorebookImages`.
 * @type {string}
 */
const LI_NAMESPACE = 'lorebookImages';

/**
 * Build the metadata key for a lorebook entry.
 * @param {string} worldName
 * @param {string|number} entryUid
 * @returns {string}
 */
function liMetaKey(worldName, entryUid) {
    return `${worldName}::${entryUid}`;
}

/**
 * Ensure the lorebook images namespace exists in extension_settings.
 * @returns {object} The lorebookImages object.
 */
export function ensureLIMeta() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    if (!extension_settings[MODULE_NAME][LI_NAMESPACE]) {
        extension_settings[MODULE_NAME][LI_NAMESPACE] = {};
    }
    return extension_settings[MODULE_NAME][LI_NAMESPACE];
}

/**
 * Get the image metadata list for a lorebook entry.
 * Each item has the shape: `{filename: string, label: string, enabled: boolean}`.
 *
 * @param {string}          worldName
 * @param {string|number}   entryUid
 * @returns {Array<{filename: string, label: string, enabled: boolean}>}
 */
export function getLorebookImages(worldName, entryUid) {
    const store = ensureLIMeta();
    const key = liMetaKey(worldName, entryUid);
    const list = store[key];
    return Array.isArray(list) ? list : [];
}

/**
 * Add an image record to a lorebook entry's metadata.
 * Does nothing if `filename` already exists.
 *
 * @param {string}          worldName
 * @param {string|number}   entryUid
 * @param {string}          filename
 * @param {string}          label
 * @returns {void}
 */
export function addLorebookImage(worldName, entryUid, filename, label) {
    const store = ensureLIMeta();
    const key = liMetaKey(worldName, entryUid);
    const list = Array.isArray(store[key]) ? store[key] : [];
    if (list.some(img => img.filename === filename)) return;
    list.push({ filename, label: label || '', enabled: true });
    store[key] = list;
    saveSettingsDebounced();
}

/**
 * Remove an image record from a lorebook entry's metadata by filename.
 *
 * @param {string}          worldName
 * @param {string|number}   entryUid
 * @param {string}          filename
 * @returns {void}
 */
export function removeLorebookImage(worldName, entryUid, filename) {
    const store = ensureLIMeta();
    const key = liMetaKey(worldName, entryUid);
    if (!Array.isArray(store[key])) return;
    store[key] = store[key].filter(img => img.filename !== filename);
    saveSettingsDebounced();
}

/**
 * Toggle the `enabled` flag of an image record for a lorebook entry.
 * Does nothing if the filename is not found.
 *
 * @param {string}          worldName
 * @param {string|number}   entryUid
 * @param {string}          filename
 * @returns {void}
 */
export function toggleLorebookImage(worldName, entryUid, filename) {
    const store = ensureLIMeta();
    const key = liMetaKey(worldName, entryUid);
    const list = store[key];
    if (!Array.isArray(list)) return;
    const image = list.find(img => img.filename === filename);
    if (image) {
        image.enabled = !image.enabled;
        saveSettingsDebounced();
    }
}

/**
 * Update the label of an image record in the metadata.
 *
 * @param {string}          worldName
 * @param {string|number}   entryUid
 * @param {string}          filename
 * @param {string}          newLabel
 * @returns {void}
 */
export function updateLorebookImageLabel(worldName, entryUid, filename, newLabel) {
    const store = ensureLIMeta();
    const key = liMetaKey(worldName, entryUid);
    const list = store[key];
    if (!Array.isArray(list)) return;
    const image = list.find(img => img.filename === filename);
    if (image) {
        image.label = newLabel;
        saveSettingsDebounced();
    }
}

// ── Settings Management ──────────────────

/**
 * Get the current lorebook image settings, merging with defaults.
 *
 * Settings are stored under `extension_settings.picture_prompt`.
 *
 * @returns {{ lorebookImagesEnabled: boolean, lorebookImagesMax: number }}
 */
export function getLorebookSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    const s = extension_settings[MODULE_NAME];
    for (const key of Object.keys(DEFAULT_LOREBOOK_SETTINGS)) {
        if (s[key] === undefined) {
            s[key] = DEFAULT_LOREBOOK_SETTINGS[key];
        }
    }
    return {
        lorebookImagesEnabled: Boolean(s.lorebookImagesEnabled),
        lorebookImagesMax: Number(s.lorebookImagesMax),
    };
}

/**
 * Save a partial set of lorebook image settings.
 *
 * Only the keys provided in `partial` will be updated; unspecified keys retain
 * their current value. Settings are persisted via `saveSettingsDebounced`.
 *
 * @param {Partial<{ lorebookImagesEnabled: boolean, lorebookImagesMax: number }>} partial
 * @returns {void}
 */
export function saveLorebookSettings(partial) {
    // Ensure the settings namespace exists and defaults are populated
    getLorebookSettings();
    const s = extension_settings[MODULE_NAME];
    for (const key of Object.keys(partial)) {
        if (key in DEFAULT_LOREBOOK_SETTINGS) {
            s[key] = partial[key];
        }
    }
    saveSettingsDebounced();
}
