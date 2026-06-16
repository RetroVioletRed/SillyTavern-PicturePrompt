/**
 * Centralized DOM selectors for the Picture Prompt extension.
 *
 * When SillyTavern updates its DOM, look here first — all hardcoded
 * selectors live in one place. checkPresent() at init-time catches
 * missing elements with a single actionable warning.
 */

export const SEL = {
    // ── ST panels & containers ──
    dragGallery:              '#dragGallery',
    gallery:                  '#gallery',
    movingDivs:               '#movingDivs',
    personaManagement:        '#PersonaManagement',
    worldPopupEntriesList:    '#world_popup_entries_list',

    // ── ST gallery classes ──
    galleryThumbnail:          '.nGY2GThumbnail',
    gallerySub:                '.nGY2GallerySub',
    galleryMain:               '.nGY2Gallery',

    // ── ST world/lorebook classes ──
    worldEntry:                '.world_entry',
    inlineDrawerOutlet:        '.inline-drawer-outlet',
    commentTextarea:           'textarea[name="comment"]',

    // ── ST UI chrome (event guards) ──
    pastChatCross:             '.PastChat_cross',
    exportRawChatButton:       '.exportRawChatButton',
    exportChatButton:          '.exportChatButton',
    renameChatButton:          '.renameChatButton',

    // ── PP extension classes ──
    injectOverlay:             '.pp-inject-overlay',
    galleryLabelOverlay:       '.pp-gallery-label-overlay',
    galleryLabelBtn:           '.pp-gallery-label-btn',
    ppLorebookImages:          '.pp-lorebook-images',
    ppLiCount:                 '.pp-li-count',
    picturePromptImageCard:    '.picture-prompt-image-card',
};

/**
 * Check that a selector is present in the DOM. Logs a single warning
 * if the element is missing — call at init/wiring time, not in hot paths.
 *
 * @param {string} selector - CSS selector string (e.g. SEL.dragGallery)
 * @param {string} [label]   - human-readable label for the warning
 * @returns {Element|null}
 */
export function checkPresent(selector, label) {
    const el = document.querySelector(selector);
    if (!el) {
        console.warn(`[PP] DOM element not found: ${label || selector} ("${selector}")`);
    }
    return el;
}
