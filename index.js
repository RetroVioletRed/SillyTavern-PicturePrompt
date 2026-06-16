import {
    eventSource,
    event_types,
} from '../../../events.js';
import {
    characters,
    this_chid,
    user_avatar,
} from '../../../../script.js';
import { SEL } from './modules/selectors.js';
import { escapeHtml } from './modules/storage.js';
import { getSettings, isGroupChat, getCharacterAvatarUrl, getPersonaAvatarUrl, addSettingsUI, getMetaForPersona, setMetaForPersona, pruneOrphanedPersonaImages } from './modules/settings.js';
import { getCharGalleryMeta, observeGallery, disconnectGalleryObserver } from './modules/gallery-images.js';
import { observePersonaPanel, onPersonaChanged, disconnectPersonaObserver } from './modules/persona-images.js';
import { showCalculating, refreshTokenEstimate } from './modules/token-estimate.js';
import { getExtraImagesForInjection } from './modules/injection-plan.js';
import { onPromptReady } from './modules/prompt-injection.js';
import { initLorebookInject, injectLorebookImages, getCachedActiveEntries, getActiveEntries, deactivateLorebookInject } from './modules/lorebook-inject.js';
import { initLorebookUI, deactivateLorebookUI } from './modules/lorebook-ui.js';
import { getLorebookSettings, getLorebookImages, getLorebookImagesDataUrls, getCached, setCached, clearFetchCache, enableGridDragReorder } from './modules/lorebook-images.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { Popup } from '../../../popup.js';

// ── Injection State ───────────────────────

let _ppInjectionStats = null;  // { total, imageCount, sources } from last injection
let _pp_personaDropdownObserver = null;

// ── Panel Watchers (Gallery + Persona) ─────────

/**
 * Consolidated DOM watcher — finds #movingDivs (gallery) and
 * #PersonaManagement (persona panel) using a single body observer.
 */
function startPanelWatchers() {
    let galleryDone = false;
    let personaDone = false;

    function tryInitGallery() {
        if (galleryDone) return;
        const el = document.querySelector(SEL.movingDivs);
        if (el) { galleryDone = true; observeGallery(el); }
    }

    function tryInitPersona() {
        if (personaDone) return;
        const el = document.querySelector(SEL.personaManagement);
        if (el) { personaDone = true; observePersonaPanel(el); }
    }

    tryInitGallery();
    tryInitPersona();

    if (typeof MutationObserver !== 'undefined') {
        const obs = new MutationObserver(() => {
            tryInitGallery();
            tryInitPersona();
            if (galleryDone && personaDone) obs.disconnect();
        });
        obs.observe(document.body, { childList: true, subtree: true });

        let retries = 0;
        const retry = () => {
            tryInitGallery();
            tryInitPersona();
            if (galleryDone && personaDone) { obs.disconnect(); return; }
            if (++retries < 15) setTimeout(retry, 2000);
            else { obs.disconnect(); console.debug('[Picture Prompt] Watchers timed out'); }
        };
        setTimeout(retry, 2000);
    }
}
// ── Init ──────────────────

// ── Named event handlers (for deactivate cleanup) ────

function _onChatChanged() {
    clearFetchCache();
    _ppInjectionStats = null;
    refreshTokenEstimate();
}

async function _onPromptReady(eventData) {
    _ppInjectionStats = await onPromptReady(eventData);
}

function _onSettingsUpdated() {
    refreshTokenEstimate();
}

function _onGenerationEnded() {
    if (!_ppInjectionStats || !_ppInjectionStats.imageCount) return;
    if (!getSettings().injectionIndicatorEnabled) return;
    $('.pp-injection-indicator').remove();
    const s = _ppInjectionStats;
    const $indicator = $(`<div class="pp-injection-indicator">🖼 ${s.imageCount} image${s.imageCount !== 1 ? 's' : ''} · ~${s.total.toLocaleString()} tokens</div>`);
    $('#chat .mes').last().append($indicator);
}

function _onChatBlockClick(e) {
    if ($(e.target).closest([SEL.pastChatCross, SEL.exportRawChatButton, SEL.exportChatButton, SEL.renameChatButton].join(', ')).length) return;
    showCalculating();
}

function _onPersonaChanged(avatarId) {
    onPersonaChanged(avatarId);
    refreshTokenEstimate();
}

// ── Slash Commands ─────────────────

async function ppStatusCallback() {
    const s = getSettings();
    const lbSettings = getLorebookSettings();
    const lines = ['<h3>Picture Prompt Status</h3>', '<table style="width:100%;border-collapse:collapse;">'];

    const row = (k, v) => `<tr><td style="padding:4px 12px 4px 0;white-space:nowrap;color:var(--text-color-dim);">${k}</td><td style="padding:4px 0;">${v}</td></tr>`;

    lines.push(row('Enabled', s.enabled ? '✓ <span style="color:var(--success-color);">yes</span>' : '✗ <span style="color:var(--error-color);">no</span>'));
    const charPos = s.positionCharAvatar === 'user' ? '<span style="color:var(--text-color-dim);"> → user</span>' : '';
    lines.push(row('Character avatar', (s.injectChar ? '✓ <span style="color:var(--success-color);">enabled</span>' : '✗ disabled') + charPos));
    const personaPos = s.positionPersonaAvatar === 'user' ? '<span style="color:var(--text-color-dim);"> → user</span>' : '';
    lines.push(row('Persona avatar', (s.injectPersona ? '✓ <span style="color:var(--success-color);">enabled</span>' : '✗ disabled') + personaPos));

    // Persona extras
    if (user_avatar) {
        const meta = getMetaForPersona(user_avatar);
        const enabled = meta.filter(m => m.enabled !== false).length;
        lines.push(row('Persona extras', `${meta.length} images (${enabled} enabled, max ${s.maxExtraImages})`));
    } else {
        lines.push(row('Persona extras', 'no persona selected'));
    }

    // Gallery pins
    const chId = Number(this_chid);
    if (!isGroupChat() && chId >= 0 && characters?.[chId]?.avatar) {
        const avatarId = characters[chId].avatar;
        const meta = getCharGalleryMeta(avatarId);
        const selected = Object.values(meta).filter(v => v.enabled).length;
        lines.push(row('Gallery pins', `${selected} selected (max ${s.charExtraImagesMax})`));
    } else if (isGroupChat()) {
        lines.push(row('Gallery pins', '<span style="color:var(--text-color-dim);">skipped — group chat</span>'));
    } else {
        lines.push(row('Gallery pins', 'no character'));
    }

    // Lorebook
    const lbEntries = await getActiveEntries();
    let lbImageCount = 0;
    for (const [, entry] of lbEntries) {
        const imgs = getLorebookImages(entry.world || '', String(entry.uid));
        lbImageCount += imgs.filter(img => img.enabled !== false).length;
    }
    lines.push(row('Lorebook', lbSettings.lorebookImagesEnabled
        ? `✓ <span style="color:var(--success-color);">enabled</span>, ${lbEntries.size} active entries (${lbImageCount} images, max ${lbSettings.lorebookImagesMax})`
        : '✗ disabled'));

    // Group chat warning
    if (isGroupChat()) {
        lines.push(row('Group chat', '<span style="color:#ffd700;">⚠ character features skipped</span>'));
    }

    lines.push('</table>');
    Popup.show.text('Picture Prompt', lines.join(''));
    return '';
}

async function ppImagesCallback() {
    const s = getSettings();
    const lbSettings = getLorebookSettings();
    const lines = ['<h3>Injection Plan</h3>'];

    const item = (label, value) => `<p style="margin:4px 0;"><span style="color:var(--text-color-dim);">${label}:</span> ${escapeHtml(String(value))}</p>`;

    // Character avatar
    if (s.injectChar && !isGroupChat()) {
        const url = getCharacterAvatarUrl();
        const posLabel = s.positionCharAvatar === 'user' ? ' → user' : '';
        const qLabel = s.qualityCharAvatar === 'global' ? '' : ` · ${s.qualityCharAvatar}`;
        lines.push(item('Character avatar', (url ? '✓ available' : '✗ not set') + qLabel + posLabel));
    } else if (isGroupChat() && s.injectChar) {
        lines.push(item('Character avatar', 'skipped — group chat'));
    }

    // Gallery pins
    const chId = Number(this_chid);
    if (s.charExtraImagesEnabled && !isGroupChat() && chId >= 0 && characters?.[chId]?.avatar) {
        const avatarId = characters[chId].avatar;
        const meta = getCharGalleryMeta(avatarId);
        const pinned = Object.entries(meta).filter(([, v]) => v.enabled);
        const max = Number.isFinite(s.charExtraImagesMax) ? Math.max(0, s.charExtraImagesMax) : 8;
        const galleryPosLabel = s.positionGalleryImages === 'user' ? ' → user' : '';
        const qLabel = s.qualityGalleryImages === 'global' ? '' : ` · ${s.qualityGalleryImages}`;
        if (pinned.length) {
            const list = pinned.slice(0, max).map(([fn, v]) => v.label || fn).join(', ');
            lines.push(item(`Gallery pins (${Math.min(pinned.length, max)} of ${pinned.length} selected, max ${max})${qLabel}${galleryPosLabel}`, list));
        } else {
            lines.push(item('Gallery pins', 'none selected'));
        }
    }

    // Persona avatar
    if (s.injectPersona) {
        const url = getPersonaAvatarUrl();
        const qLabel = s.qualityPersonaAvatar === 'global' ? '' : ` · ${s.qualityPersonaAvatar}`;
        const personaPosLabel = s.positionPersonaAvatar === 'user' ? ' → user' : '';
        lines.push(item('Persona avatar', (url ? '✓ available' : '✗ not set') + qLabel + personaPosLabel));
    }

    // Persona extras
    if (s.extraImagesEnabled && user_avatar) {
        const extras = await getExtraImagesForInjection(user_avatar);
        const extraPosLabel = s.positionExtraImages === 'user' ? ' → user' : '';
        const qLabel = s.qualityExtraImages === 'global' ? '' : ` · ${s.qualityExtraImages}`;
        if (extras.length) {
            const max = Number.isFinite(s.maxExtraImages) ? Math.max(0, s.maxExtraImages) : 8;
            const list = extras.slice(0, max).map(m => m.label || m.filename).join(', ');
            lines.push(item(`Persona extras (${Math.min(extras.length, max)} of ${extras.length} available, max ${max})${qLabel}${extraPosLabel}`, list));
        } else {
            lines.push(item('Persona extras', 'none available'));
        }
    }

    // Lorebook
    if (s.lorebookImagesEnabled) {
        const entries = await getActiveEntries();
        const lbPosLabel = s.positionLorebookImages === 'user' ? ' → user' : '';
        const lbQ = s.qualityLorebookImages === 'global' ? '' : ` · ${s.qualityLorebookImages}`;
        if (entries.size) {
            const max = Number.isFinite(lbSettings.lorebookImagesMax) ? Math.max(0, lbSettings.lorebookImagesMax) : 4;
            let remaining = max;
            const entryLines = [];
            for (const [, entry] of entries) {
                if (remaining <= 0) break;
                const wName = entry.world || '';
                const uid = String(entry.uid);
                const imgs = getLorebookImages(wName, uid);
                const enabled = imgs.filter(img => img.enabled !== false);
                const toShow = enabled.slice(0, remaining);
                if (toShow.length) {
                    const title = entry.comment || uid;
                    const imgList = toShow.map(img => img.label || img.filename).join(', ');
                    entryLines.push(`<li>"${escapeHtml(title)}" → ${imgList}</li>`);
                    remaining -= toShow.length;
                }
            }
            if (entryLines.length) {
                lines.push(`<p style="margin:4px 0;"><span style="color:var(--text-color-dim);">Lorebook (${entries.size} active, max ${max})${lbQ}${lbPosLabel}:</span></p><ul style="margin:4px 0;">${entryLines.join('')}</ul>`);
            } else {
                lines.push(item('Lorebook', `${entries.size} active entries, no enabled images`));
            }
        } else {
            lines.push(item('Lorebook', 'no active entries'));
        }
    }

    if (lines.length === 1) {
        lines.push('<p style="color:var(--text-color-dim);">No images configured for injection.</p>');
    }

    Popup.show.text('Picture Prompt', lines.join(''));
    return '';
}

async function ppCacheCallback() {
    clearFetchCache();
    toastr.success('Image data URL cache cleared', 'Picture Prompt');
    return '';
}

export async function activate() {
    getSettings();
    await pruneOrphanedPersonaImages();
    await addSettingsUI();
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, _onPromptReady);
    eventSource.on(event_types.GENERATION_ENDED, _onGenerationEnded);
    eventSource.on(event_types.PERSONA_CHANGED, _onPersonaChanged);
    eventSource.on(event_types.CHAT_CHANGED, _onChatChanged);
    eventSource.on(event_types.SETTINGS_UPDATED, _onSettingsUpdated);
    startPanelWatchers();
    initLorebookUI();
    initLorebookInject();

    // ── Slash commands ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pp-status',
        callback: ppStatusCallback,
        helpString: 'Show Picture Prompt extension status',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pp-images',
        callback: ppImagesCallback,
        helpString: 'Show what images would be injected on the next message',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pp-cache',
        callback: ppCacheCallback,
        helpString: 'Clear the image data URL cache',
    }));

    // ── Early-visible 'calculating...' hooks ─────────────────────
    // ST's event system fires late — these bridge the visual gap by
    // showing 'calculating...' before the real estimate runs.

    // Chat block clicks (chat switcher)
    $(document).on('click', '.select_chat_block', _onChatBlockClick);

    // Persona dropdown changes — fires before PERSONA_CHANGED event
    if (typeof MutationObserver !== 'undefined') {
        _pp_personaDropdownObserver = new MutationObserver(() => showCalculating());
        // Observe after a short delay — the dropdown may not be in DOM yet
        const tryObservePersona = () => {
            const $dd = $('#persona-management-dropdown');
            if ($dd.length) {
                _pp_personaDropdownObserver.observe($dd[0], { subtree: true, childList: true, characterData: true });
            } else {
                setTimeout(tryObservePersona, 200);
            }
        };
        setTimeout(tryObservePersona, 100);
    }

    console.debug('[Picture Prompt] Activated');
    refreshTokenEstimate();
}

export async function deactivate() {
    // ── MutationObservers ──
    disconnectGalleryObserver();
    disconnectPersonaObserver();
    _pp_personaDropdownObserver?.disconnect();
    _pp_personaDropdownObserver = null;

    // Gallery content observer (attached to DOM element, not module-level)
    const dragGallery = document.querySelector(SEL.dragGallery);
    if (dragGallery?._pp_contentObserver) {
        dragGallery._pp_contentObserver.disconnect();
        delete dragGallery._pp_contentObserver;
    }

    // ── jQuery global delegate ──
    $(document).off('click', '.select_chat_block', _onChatBlockClick);

    // ── EventSource listeners ──
    eventSource.removeListener(event_types.CHAT_COMPLETION_PROMPT_READY, _onPromptReady);
    eventSource.removeListener(event_types.GENERATION_ENDED, _onGenerationEnded);
    eventSource.removeListener(event_types.PERSONA_CHANGED, _onPersonaChanged);
    eventSource.removeListener(event_types.CHAT_CHANGED, _onChatChanged);
    eventSource.removeListener(event_types.SETTINGS_UPDATED, _onSettingsUpdated);

    // ── Sub-modules ──
    deactivateLorebookUI();
    deactivateLorebookInject();

    // ── Slash commands (no public remove API — delete from internal registry) ──
    delete SlashCommandParser.commands['pp-status'];
    delete SlashCommandParser.commands['pp-images'];
    delete SlashCommandParser.commands['pp-cache'];

    console.debug('[Picture Prompt] Deactivated');
}
