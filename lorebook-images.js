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

/**
 * Replace the entire image metadata array for a lorebook entry.
 * Used by drag-to-reorder to persist a new order.
 *
 * @param {string}          worldName
 * @param {string|number}   entryUid
 * @param {Array}           arr - New metadata array
 */
export function setLorebookImages(worldName, entryUid, arr) {
    const store = ensureLIMeta();
    const key = resolveKey(worldName, entryUid);
    store[key] = arr;
    saveSettingsDebounced();
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

// ── Drag-to-Reorder (snapping-free) ────

/**
 * Enable snapping-free drag-to-reorder on an image grid.
 *
 * Dragged card floats out-of-flow (position:fixed + transform following cursor).
 * A placeholder preserves grid layout. All grid items get FLIP-animated when the
 * placeholder moves — the dragged card itself never animates during drag.
 *
 * Cards must have `data-filename` and class `.picture-prompt-image-card`.
 *
 * @param {string|Element|jQuery} gridSelector - Grid container
 * @param {() => Array}            getArray    - Return current metadata array
 * @param {(arr: Array) => void}   setArray    - Persist reordered array
 */
export function enableGridDragReorder(gridSelector, getArray, setArray) {
    const grid = typeof gridSelector === 'string'
        ? document.querySelector(gridSelector)
        : gridSelector[0] || gridSelector;
    if (!grid) return;
    // Tear down previous registration if present (persona switch, etc.)
    if (grid._ppCleanup) grid._ppCleanup();

    let card     = null;   // The DOM element being dragged
    let floatLeft = 0;     // position:fixed left (pin anchor)
    let floatTop  = 0;     // position:fixed top  (pin anchor)
    let grabOX    = 0;     // cursor offset from card top-left at mousedown
    let grabOY    = 0;
    let active   = false;  // Past the drag threshold?
    let startX, startY;
    let placeholder  = null;
    let lastTarget   = null;
    let lastBefore   = null;
    let settlingAnim = null;  // rAF id for drop-settle
    let _dropped = false;     // Guard against double finishDrop

    // ── Helpers ──────────────────────────

    /** Extract clientX/clientY from mouse or touch events. */
    function getCoords(e) {
        if (e.touches) {
            return e.touches.length
                ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
                : null;
        }
        if (e.changedTouches) {
            return e.changedTouches.length
                ? { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY }
                : null;
        }
        return { x: e.clientX, y: e.clientY };
    }

    /** Find the nearest card to the cursor, excluding the dragged card & placeholder. */
    function findTarget(x, y) {
        let best = null, bestDist = Infinity, bestBefore = false;
        for (const c of grid.querySelectorAll('.picture-prompt-image-card')) {
            if (c === card) continue;
            if (c.classList.contains('pp-placeholder')) continue;
            const r = c.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const d = (x - cx) ** 2 + (y - cy) ** 2;
            if (d < bestDist) { bestDist = d; best = c; bestBefore = x < cx; }
        }
        return best ? { card: best, before: bestBefore } : null;
    }

    /**
     * FLIP all grid cards (excluding the dragged card & placeholder).
     * Returns a zero-arg function that applies the FLIP animation.
     */
    function captureFlip() {
        const before = new Map();
        const items = [];
        for (const c of grid.querySelectorAll('.picture-prompt-image-card')) {
            if (c === card) continue;
            if (c.classList.contains('pp-placeholder')) continue;
            const r = c.getBoundingClientRect();
            before.set(c, { left: r.left, top: r.top });
            c.style.transition = 'none';
            c.style.transform = '';
            items.push(c);
        }
        return function animateFlip() {
            for (const c of items) {
                const r = c.getBoundingClientRect();
                const old = before.get(c);
                if (!old) continue;
                const dx = old.left - r.left;
                const dy = old.top - r.top;
                if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
                c.style.transform = `translate(${dx}px, ${dy}px)`;
                // Force reflow so the browser applies the transform before adding transition
                void c.offsetHeight;
                c.style.transition = 'transform 0.2s ease';
                c.style.transform = '';
            }
        };
    }

    /** Move placeholder to new DOM position and FLIP-animate all other cards. */
    function movePlaceholder(targetCard, before) {
        if (!placeholder) return;
        const animate = captureFlip();
        const ref = before ? targetCard : targetCard.nextSibling;
        // Don't no-op if ref is already correct — captureFlip still needs to run
        // to clear any stale transforms, but the grid won't shift if position
        // didn't change. Safe to call unconditionally.
        grid.insertBefore(placeholder, ref);
        animate();
    }

    /** Build the placeholder element. */
    function createPlaceholder(rect) {
        const el = document.createElement('div');
        el.className = 'picture-prompt-image-card pp-placeholder';
        el.style.width      = rect.width + 'px';
        el.style.height     = rect.height + 'px';
        el.style.minWidth   = rect.width + 'px';
        el.style.minHeight  = rect.height + 'px';
        el.style.flexShrink = '0';
        el.style.flexGrow   = '0';
        el.style.pointerEvents = 'none';
        el.dataset.filename = '__placeholder__';
        return el;
    }

    /** Lift the card out of flow into a fixed-position floater. */
    function liftCard(c, rect, px, py) {
        floatLeft = rect.left;
        floatTop  = rect.top;
        grabOX = startX - rect.left;
        grabOY = startY - rect.top;

        // Move to document.body so no ancestor transform alters the
        // containing block for position:fixed (common in ST panels).
        document.body.appendChild(c);

        c.style.position   = 'fixed';
        c.style.left       = floatLeft + 'px';
        c.style.top        = floatTop + 'px';
        c.style.width      = rect.width + 'px';
        c.style.height     = rect.height + 'px';
        c.style.margin     = '0';
        c.style.zIndex     = '5000';
        c.style.pointerEvents = 'none';
        c.style.transition = 'none';
        c.style.transform  = `translate(${px - floatLeft - grabOX}px, ${py - floatTop - grabOY}px)`;

        c.classList.add('pp-dragging');
    }

    /** Cancel the drag — return card to its original position. */
    function cancelDrag() {
        if (!card) return;
        cleanupAfterDrop();
    }

    /** Persist the current grid order and clean up. */
    function dropCard() {
        if (!card) return;
        if (!placeholder) { cleanupAfterDrop(); return; }

        const el = card;
        const ph  = placeholder;
        card = null;
        placeholder = null;

        // Calculate the visual delta from where the card is now → placeholder
        const phRect = ph.getBoundingClientRect();
        el.style.transition = 'left 0.22s cubic-bezier(0.2, 0, 0, 1), top 0.22s cubic-bezier(0.2, 0, 0, 1)';
        el.style.left  = phRect.left + 'px';
        el.style.top   = phRect.top + 'px';
        el.style.transform = 'none';

        function onSettle() {
            el.removeEventListener('transitionend', onSettle);
            finishDrop(el, ph);
        }
        el.addEventListener('transitionend', onSettle);
        // Safety: if transitionend never fires (e.g. card already at position)
        settlingAnim = requestAnimationFrame(() => {
            settlingAnim = requestAnimationFrame(() => {
                if (settlingAnim) {
                    settleNow();
                }
            });
        });

        function settleNow() {
            if (settlingAnim) { cancelAnimationFrame(settlingAnim); settlingAnim = null; }
            el.removeEventListener('transitionend', onSettle);
            finishDrop(el, ph);
        }
    }

    function finishDrop(el, ph) {
        if (_dropped) return;
        _dropped = true;
        settlingAnim = null;
        // Only proceed if placeholder is still in the DOM
        if (!ph.parentNode) return;
        grid.insertBefore(el, ph);
        ph.remove();
        el.style.position   = '';
        el.style.left       = '';
        el.style.top        = '';
        el.style.width      = '';
        el.style.height     = '';
        el.style.margin     = '';
        el.style.zIndex     = '';
        el.style.pointerEvents = '';
        el.style.transition = '';
        el.style.transform  = '';
        el.classList.remove('pp-dragging');

        persistOrder();
    }

    function cleanupAfterDrop() {
        if (!card) return;
        const el = card;
        card = null;

        // If the card was lifted (appended to document.body), move it back.
        if (placeholder && placeholder.parentNode) {
            grid.insertBefore(el, placeholder);
        }
        if (placeholder) { placeholder.remove(); placeholder = null; }
        if (settlingAnim) { cancelAnimationFrame(settlingAnim); settlingAnim = null; }
        el.style.position   = '';
        el.style.left       = '';
        el.style.top        = '';
        el.style.width      = '';
        el.style.height     = '';
        el.style.margin     = '';
        el.style.zIndex     = '';
        el.style.pointerEvents = '';
        el.style.transition = '';
        el.style.transform  = '';
        el.classList.remove('pp-dragging');
        // Clear any leftover transforms on other cards
        for (const c of grid.querySelectorAll('.picture-prompt-image-card')) {
            c.style.transition = '';
            c.style.transform  = '';
        }
        active = false;
        lastTarget = null;
        lastBefore = null;
    }

    function persistOrder() {
        const filenames = [...grid.querySelectorAll('.picture-prompt-image-card')]
            .filter(c => !c.classList.contains('pp-placeholder'))
            .map(c => c.dataset.filename);
        const arr = getArray();
        const visible = filenames.map(fn => arr.find(i => i.filename === fn)).filter(Boolean);
        const orphans = arr.filter(i => !filenames.includes(i.filename));
        const reordered = visible.concat(orphans);
        if (reordered.length === arr.length) {
            setArray(reordered);
        }
    }

    // ── Event handlers ───────────────────

    function onPointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return; // non-left mouse
        const c = e.target.closest('.picture-prompt-image-card');
        if (!c) return;
        if (c.classList.contains('pp-placeholder')) return;
        if (e.target.closest('button, input, label')) return;
        e.preventDefault();

        card = c;
        active = false;
        _dropped = false;
        lastTarget = null;
        lastBefore = null;
        const coords = getCoords(e);
        if (!coords) return;
        startX = coords.x;
        startY = coords.y;
    }

    function onPointerMove(e) {
        if (!card) return;
        const coords = getCoords(e);
        if (!coords) return;
        const cx = coords.x, cy = coords.y;
        if (!active) {
            if (Math.abs(cx - startX) < 3 && Math.abs(cy - startY) < 3) return;
            // ── LIFT ──
            active = true;
            const rect = card.getBoundingClientRect();  // capture BEFORE placeholder insertion
            placeholder = createPlaceholder(rect);
            grid.insertBefore(placeholder, card);
            liftCard(card, rect, cx, cy);
            lastTarget = null;
            lastBefore = null;
        }

        // Update floating card position (maintain the grab offset)
        card.style.transform = `translate(${cx - floatLeft - grabOX}px, ${cy - floatTop - grabOY}px)`;

        const t = findTarget(cx, cy);
        if (!t) {
            lastTarget = null;
            lastBefore = null;
            return;
        }
        if (t.card === lastTarget && t.before === lastBefore) return;
        lastTarget = t.card;
        lastBefore = t.before;
        movePlaceholder(t.card, t.before);
    }

    function onPointerUp(e) {
        if (!card) return;
        if (!active) {
            // Never crossed threshold — just a click, abort
            cleanupAfterDrop();
            return;
        }
        dropCard();
    }

    function onKeyDown(e) {
        if (e.key === 'Escape' && card && active) {
            e.preventDefault();
            cancelDrag();
        }
    }

    // ── Bind ─────────────────────────────

    grid.addEventListener('mousedown', onPointerDown);
    grid.addEventListener('touchstart', onPointerDown, { passive: false });
    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('touchmove', onPointerMove, { passive: false });
    document.addEventListener('mouseup', onPointerUp);
    document.addEventListener('touchend', onPointerUp);
    document.addEventListener('keydown', onKeyDown);

    // Store cleanup for re-init (persona switch etc.)
    grid._ppCleanup = () => {
        grid.removeEventListener('mousedown', onPointerDown);
        grid.removeEventListener('touchstart', onPointerDown);
        document.removeEventListener('mousemove', onPointerMove);
        document.removeEventListener('touchmove', onPointerMove);
        document.removeEventListener('mouseup', onPointerUp);
        document.removeEventListener('touchend', onPointerUp);
        document.removeEventListener('keydown', onKeyDown);
        delete grid._ppCleanup;
    };
}
