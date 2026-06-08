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
export const STORE_NAME = 'extraImages';

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
 * Cached connection promise — reused across all DB operations.
 * Reset on error so the next attempt opens a fresh connection.
 * @type {Promise<IDBDatabase>|null}
 */
let _dbPromise = null;

/**
 * Open (or create) the IndexedDB database.
 * The connection is cached so multiple calls within a single prompt
 * cycle (e.g. putLorebookImage → listLorebookImages → getLorebookImage)
 * reuse the same handle instead of opening 10–20 separate connections.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
    if (!_dbPromise) {
        _dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE_NAME)) {
                    req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => {
                _dbPromise = null; // clear cache so next attempt retries
                reject(req.error);
            };
        });
    }
    return _dbPromise;
}

export { openDB };

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
/**
 * Batch-read multiple lorebook images and convert to data URLs.
 * Fetches all records in a single IndexedDB transaction, then converts
 * blobs to data URLs in parallel — replaces N sequential getLorebookImage
 * + blobToDataURL calls with 1 transaction + parallel FileReader.
 *
 * Used by the lorebook estimate/inject loops when cache is cold.
 *
 * @param {string} worldName
 * @param {string|number} entryUid
 * @param {string[]} filenames
 * @returns {Promise<Map<string, string>>} Map of filename → dataUrl (only successful entries)
 */
export async function getLorebookImagesDataUrls(worldName, entryUid, filenames) {
    if (!filenames.length) return new Map();
    const db = await openDB();

    // Step 1 — batch-read all records in a single IndexedDB transaction
    const records = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const results = new Array(filenames.length);
        let remaining = filenames.length;
        filenames.forEach((filename, i) => {
            const id = lorebookKey(worldName, String(entryUid), filename);
            const req = store.get(id);
            req.onsuccess = () => {
                results[i] = { filename, blob: req.result?.blob || null };
                if (--remaining === 0) resolve(results);
            };
            req.onerror = () => reject(req.error);
        });
    });

    // Step 2 — convert blobs to data URLs in parallel
    const dataUrls = await Promise.all(
        records.map(r => r.blob ? blobToDataURL(r.blob) : Promise.resolve(null))
    );

    // Step 3 — build result map
    const map = new Map();
    for (let i = 0; i < records.length; i++) {
        if (dataUrls[i]) map.set(records[i].filename, dataUrls[i]);
    }
    return map;
}

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
 * Resolve the effective key for an entry, trying the exact worldName first
 * then falling back to a suffix search (entryUid may have been stored under
 * a slightly different world name — e.g. UI dropdown vs. entry.world).
 * @param {string} worldName
 * @param {string|number} entryUid
 * @returns {string|null}
 */
function resolveKey(worldName, entryUid) {
    const store = ensureLIMeta();
    const exact = liMetaKey(worldName, entryUid);
    if (store[exact]) return exact;
    // Fallback: search for any key ending with ::entryUid
    const suffix = `::${entryUid}`;
    for (const k of Object.keys(store)) {
        if (k.endsWith(suffix)) return k;
    }
    return exact; // return exact key even if not found (for write operations)
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
    const key = resolveKey(worldName, entryUid);
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
    const key = resolveKey(worldName, entryUid);
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
    const key = resolveKey(worldName, entryUid);
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
    const key = resolveKey(worldName, entryUid);
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
    const key = resolveKey(worldName, entryUid);
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

// ── Shared Utilities ──────────────────────

/**
 * Convert a Blob to a base64 data URL.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

/**
 * HTML-escape a string for safe DOM insertion.
 * Reuses a single cached element instead of allocating per call.
 * @param {string} str
 * @returns {string}
 */
const _escapeDiv = document.createElement('div');
export function escapeHtml(str) {
    _escapeDiv.textContent = str ?? '';
    return _escapeDiv.innerHTML;
}

// ── Image Data URL Cache ──────────────────
// Prevents double-fetching images during the token-estimate → prompt-inject
// cycle. Invalidated on CHAT_CHANGED, PERSONA_CHANGED, WORLD_INFO_ACTIVATED.
// No TTL — cache lives until the data source actually changes.

/** @type {Map<string, {value: any, timestamp: number}>} */
const _fetchCache = new Map();

/**
 * Retrieve a cached value by key.
 * @param {string} key
 * @returns {any|undefined} The cached value, or undefined on cache miss.
 */
export function getCached(key) {
    const entry = _fetchCache.get(key);
    if (entry) return entry.value;
    return undefined;
}

/**
 * Store a value in the cache.
 * @param {string} key
 * @param {any} value
 */
export function setCached(key, value) {
    _fetchCache.set(key, { value, timestamp: Date.now() });
}

/**
 * Clear the entire image data URL cache.
 * Called on chat change, persona change, and world info activation.
 */
export function clearFetchCache() {
    _fetchCache.clear();
}
