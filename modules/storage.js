/**
 * storage.js — Shared IndexedDB storage layer for Picture Prompt.
 *
 * Provides the database connection, constants, shared utilities, and
 * character/persona CRUD operations. Lorebook-specific CRUD lives in
 * lorebook-images.js (which imports from here).
 *
 * @module storage
 */

// ── Constants ───────────────────────────

/** @type {string} */
const DB_NAME = 'PicturePrompt';

/** @type {number} */
const DB_VERSION = 1;

/** @type {string} */
export const STORE_NAME = 'extraImages';

// ── IndexedDB Connection ────────────────

/** @type {Promise<IDBDatabase>|null} */
let _dbPromise = null;

/**
 * Open (or return cached) IndexedDB connection.
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
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
                _dbPromise = null;
                reject(req.error);
            };
        });
    }
    return _dbPromise;
}

// ── Shared Utilities ────────────────────

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

// ── Logging ──────────────────────────────
// Session-only debug flag — flip via /pp-debug, resets to false on deactivate.
// warn/error stay ungated (operational).
let _debug = false;
export const isDebug = () => _debug;
export const setDebug = v => { _debug = !!v; };

const TAG = '[Picture Prompt]';
export const log = {
    debug: (...a) => { if (_debug) console.debug(TAG, ...a); },
    warn:  (...a) => console.warn(TAG, ...a),
    error: (...a) => console.error(TAG, ...a),
};

/** Cached escape element (avoids allocating per call). */
const _escapeDiv = document.createElement('div');

/**
 * HTML-escape a string for safe DOM insertion.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
    _escapeDiv.textContent = str ?? '';
    return _escapeDiv.innerHTML;
}

// ── Character / Persona CRUD ─────────────

/**
 * @param {string} id - "avatarId::filename"
 * @param {Blob} blob
 * @param {{filename: string, label: string}} meta
 */
export async function dbPut(id, blob, meta) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ id, blob, meta, storedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** @returns {Promise<{blob: Blob, meta: object}|null>} */
export async function dbGet(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Batch-read multiple records in a single transaction.
 * @param {string[]} keys
 * @returns {Promise<(object|null)[]>}
 */
export async function dbGetAll(keys) {
    if (!keys.length) return [];
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const results = new Array(keys.length);
        let remaining = keys.length;
        keys.forEach((key, i) => {
            const req = store.get(key);
            req.onsuccess = () => {
                results[i] = req.result || null;
                if (--remaining === 0) resolve(results);
            };
            req.onerror = () => reject(req.error);
        });
    });
}

export async function dbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * List all image IDs for a persona (prefix match).
 * @param {string} avatarId
 * @returns {Promise<string[]>}
 */
export async function dbListForPersona(avatarId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const range = IDBKeyRange.bound(`${avatarId}::`, `${avatarId}::\uffff`);
        const req = tx.objectStore(STORE_NAME).getAll(range);
        req.onsuccess = () => resolve((req.result || []).map(e => e.id));
        req.onerror = () => reject(req.error);
    });
}

/**
 * Delete all images for a persona.
 * @param {string} avatarId
 */
export async function dbDeleteAllForPersona(avatarId) {
    const ids = await dbListForPersona(avatarId);
    for (const id of ids) {
        await dbDelete(id);
    }
}

/**
 * Get a displayable URL for an image (blob: URL from IndexedDB).
 * @param {string} avatarId
 * @param {string} filename
 * @returns {Promise<string|null>}
 */
export async function getImageDisplayUrl(avatarId, filename) {
    const id = `${avatarId}::${filename}`;
    const entry = await dbGet(id);
    if (!entry?.blob) return null;
    return URL.createObjectURL(entry.blob);
}
