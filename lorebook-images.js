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

// ── Entry Metadata Accessors ─────────────

/**
 * Get the `picturePromptImages` array from a world info entry object.
 * Returns a new empty array if the property does not exist (does NOT mutate the entry).
 *
 * Each entry item has the shape: `{filename: string, label: string, enabled: boolean}`.
 *
 * @param {object} entry - A world info entry object (plain object from world_info data).
 * @returns {Array<{filename: string, label: string, enabled: boolean}>}
 */
export function getEntryImages(entry) {
    if (!entry || !Array.isArray(entry.picturePromptImages)) {
        return [];
    }
    return entry.picturePromptImages;
}

/**
 * Set the `picturePromptImages` array on a world info entry (mutates in-place).
 *
 * @param {object}  entry  - A world info entry object (mutated in-place).
 * @param {Array<{filename: string, label: string, enabled: boolean}>} images
 * @returns {void}
 */
export function setEntryImages(entry, images) {
    if (!entry) return;
    entry.picturePromptImages = Array.isArray(images) ? images : [];
}

/**
 * Add an image record to a world info entry's `picturePromptImages` array.
 * Does nothing if `filename` already exists in the array.
 * Mutates the entry in-place.
 *
 * @param {object} entry    - A world info entry object (mutated in-place).
 * @param {string} filename - Image filename.
 * @param {string} label    - Display label.
 * @returns {void}
 */
export function addEntryImage(entry, filename, label) {
    if (!entry) return;
    const images = getEntryImages(entry);

    // Prevent duplicates
    if (images.some(img => img.filename === filename)) return;

    entry.picturePromptImages = [
        ...images,
        { filename, label: label || '', enabled: true },
    ];
}

/**
 * Remove an image record from a world info entry's `picturePromptImages` array
 * by filename. Mutates the entry in-place.
 *
 * @param {object} entry    - A world info entry object (mutated in-place).
 * @param {string} filename - Image filename to remove.
 * @returns {void}
 */
export function removeEntryImage(entry, filename) {
    if (!entry || !Array.isArray(entry.picturePromptImages)) return;
    entry.picturePromptImages = entry.picturePromptImages.filter(
        img => img.filename !== filename,
    );
}

/**
 * Toggle the `enabled` flag of an image record on a world info entry.
 * Does nothing if the filename is not found.
 * Mutates the entry in-place.
 *
 * @param {object} entry    - A world info entry object (mutated in-place).
 * @param {string} filename - Image filename to toggle.
 * @returns {void}
 */
export function toggleEntryImage(entry, filename) {
    if (!entry || !Array.isArray(entry.picturePromptImages)) return;
    const image = entry.picturePromptImages.find(img => img.filename === filename);
    if (image) {
        image.enabled = !image.enabled;
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
