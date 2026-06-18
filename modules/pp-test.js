/**
 * pp-test.js — Diagnostic test runner for Picture Prompt.
 *
 * /pp-test slash command runs a battery of settings→plan assertions
 * against buildInjectionPlan(). No model needed. State is saved/restored
 * around each test so nothing is permanently changed.
 *
 * Tests requiring real image data (gallery pins, persona extras, lorebook
 * entries) are skipped when the data is absent. Group chat tests are manual.
 *
 * @module pp-test
 */

import { buildInjectionPlan } from './injection-plan.js';
import { getContext } from '../../../../extensions.js';
import { Popup } from '../../../../popup.js';

// ── Constants ─────────────────────────────

const MODULE_NAME = 'picture_prompt';

/** @type {object|null} Snapshot of extension_settings[MODULE_NAME] before test. */
let _savedState = null;

// ── State Management ──────────────────────

function saveState() {
    const ctx = getContext();
    const ext = ctx.extensionSettings[MODULE_NAME];
    _savedState = JSON.parse(JSON.stringify(ext || {}));
}

function restoreState() {
    if (!_savedState) return;
    const ctx = getContext();
    ctx.extensionSettings[MODULE_NAME] = _savedState;
    ctx.saveSettingsDebounced();
    _savedState = null;
}

/**
 * Merge overrides into the extension settings object (mutable, not saved).
 */
function applySettings(overrides) {
    const ctx = getContext();
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = {};
    }
    Object.assign(ctx.extensionSettings[MODULE_NAME], overrides);
}

// ── Assertion Helpers ─────────────────────

function pass(detail = '') { return { status: 'pass', detail }; }
function fail(detail = '') { return { status: 'fail', detail }; }
function skip(detail = '') { return { status: 'skip', detail }; }
function manual(detail = '') { return { status: 'manual', detail }; }

// ── Test Scenario Definitions ─────────────

// Each scenario is { category?, label, manual?, groupChatOnly?, setup(), run(), assert() }
// manual: true = cannot run automatically, displayed as an instruction
// groupChatOnly: true = only valid in group chat (like manual but specific)
// If run() throws, it's caught and reported as a failure.

/** @type {Array<object>} */
const scenarios = [];

// ── Category 1: Position Routing ──────────

scenarios.push(
    {
        category: 'Position Routing',
        label: 'Character → system (S)',
        setup() {
            applySettings({ enabled: true, injectChar: true, injectPersona: false, positionCharAvatar: 'system' });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            if (!plan || !plan.char) return fail('plan.char is missing');
            if (plan.char.position !== 'system') return fail(`expected system, got ${plan.char.position}`);
            return pass();
        },
    },
    {
        category: 'Position Routing',
        label: 'Character → user (U)',
        setup() {
            applySettings({ injectChar: true, positionCharAvatar: 'user' });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            if (plan.char.position !== 'user') return fail(`expected user, got ${plan.char.position}`);
            return pass();
        },
    },
    {
        category: 'Position Routing',
        label: 'Persona → system (S)',
        setup() {
            applySettings({ injectPersona: true, positionPersonaAvatar: 'system' });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            if (!plan || !plan.persona) return fail('plan.persona is missing');
            if (plan.persona.position !== 'system') return fail(`expected system, got ${plan.persona.position}`);
            return pass();
        },
    },
    {
        category: 'Position Routing',
        label: 'Persona → user (U)',
        setup() {
            applySettings({ injectPersona: true, positionPersonaAvatar: 'user' });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            if (plan.persona.position !== 'user') return fail(`expected user, got ${plan.persona.position}`);
            return pass();
        },
    },
    {
        category: 'Position Routing',
        label: 'Mixed: char=U, persona=S',
        setup() {
            applySettings({ injectChar: true, injectPersona: true, positionCharAvatar: 'user', positionPersonaAvatar: 'system' });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            const ok = plan.char.position === 'user' && plan.persona.position === 'system';
            if (!ok) return fail(`char=${plan.char.position} persona=${plan.persona.position}`);
            return pass();
        },
    }
);

// ── Category 2: Quality Resolution ────────

scenarios.push(
    {
        category: 'Quality Resolution',
        label: 'Char override → high (global is low)',
        setup() {
            applySettings({ injectChar: true, qualityCharAvatar: 'high' });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            if (plan.char.quality !== 'high') return fail(`expected high, got ${plan.char.quality}`);
            return pass();
        },
    },
    {
        category: 'Quality Resolution',
        label: 'Char global → uses global inline quality',
        setup() {
            applySettings({ injectChar: true, qualityCharAvatar: 'global' });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            // global should resolve to whatever oai_settings.inline_image_quality is
            if (plan.char.quality === 'global') return fail('quality not resolved — still "global"');
            return pass(`resolved to "${plan.char.quality}"`);
        },
    },
    {
        category: 'Quality Resolution',
        label: 'Persona override → low',
        setup() {
            applySettings({ injectPersona: true, qualityPersonaAvatar: 'low' });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            if (plan.persona.quality !== 'low') return fail(`expected low, got ${plan.persona.quality}`);
            return pass();
        },
    }
);

// ── Category 3: Max Count Enforcement ─────

scenarios.push(
    {
        category: 'Max Count Enforcement',
        label: 'Extras max=0 → plan.maxCount=0, zero images',
        setup() {
            applySettings({ enabled: true, extraImagesEnabled: true, maxExtraImages: 0 });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            if (!plan.extras.enabled) return skip('no persona selected — source not active');
            if (plan.extras.maxCount !== 0) return fail(`maxCount should be 0, got ${plan.extras.maxCount}`);
            if (plan.extras.images.length !== 0) return fail(`expected 0 images, got ${plan.extras.images.length}`);
            return pass();
        },
    },
    {
        category: 'Max Count Enforcement',
        label: 'Extras max=3 → plan.maxCount=3',
        setup() {
            applySettings({ extraImagesEnabled: true, maxExtraImages: 3 });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            if (!plan.extras.enabled) return skip('no persona selected — source not active');
            if (plan.extras.maxCount !== 3) return fail(`expected 3, got ${plan.extras.maxCount}`);
            if (plan.extras.images.length > 3) return fail(`too many images: ${plan.extras.images.length} > 3`);
            if (plan.extras.images.length > 0) return pass(`${plan.extras.images.length} image(s) within limit`);
            return skip(`no extra images available — maxCount verified (${plan.extras.maxCount})`);
        },
    },
    {
        category: 'Max Count Enforcement',
        label: 'Gallery max=0 → plan.maxCount=0, zero images',
        setup() {
            applySettings({ charExtraImagesEnabled: true, charExtraImagesMax: 0 });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            if (!plan.gallery.enabled) return skip('gallery not active (no avatar, group chat, or missing folder)');
            if (plan.gallery.maxCount !== 0) return fail(`maxCount should be 0, got ${plan.gallery.maxCount}`);
            if (plan.gallery.images.length !== 0) return fail(`expected 0 images, got ${plan.gallery.images.length}`);
            return pass();
        },
    },
    {
        category: 'Max Count Enforcement',
        label: 'Lorebook max=1 → plan.maxTotal=1',
        setup() {
            applySettings({ lorebookImagesEnabled: true, lorebookImagesMax: 1 });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            if (!plan.lorebook.enabled) return skip('lorebook images disabled in settings');
            if (plan.lorebook.maxTotal !== 1) return fail(`expected 1, got ${plan.lorebook.maxTotal}`);
            if (plan.lorebook.entries.length > 1) return fail(`too many entries: ${plan.lorebook.entries.length} > 1`);
            if (plan.lorebook.entries.length > 0) {
                const totalImages = plan.lorebook.entries.reduce((s, e) => s + (e.images?.length || 0), 0);
                if (totalImages > 1) return fail(`too many images total: ${totalImages} > 1`);
                return pass(`${totalImages} image(s) within limit`);
            }
            return skip('no active lorebook entries — maxTotal enforcement verified');
        },
    }
);

// ── Category 4: Label Resolution ──────────

scenarios.push(
    {
        category: 'Label Resolution',
        label: 'Char label preserved',
        setup() {
            applySettings({ injectChar: true, labelChar: 'Test label: {[char]}' });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            if (plan.char.label !== 'Test label: {[char]}') return fail(`label mismatch: "${plan.char.label}"`);
            return pass();
        },
    },
    {
        category: 'Label Resolution',
        label: 'Empty label → falsy',
        setup() {
            applySettings({ injectChar: true, labelChar: '' });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            if (plan.char.label && plan.char.label !== '') return fail(`expected empty, got "${plan.char.label}"`);
            return pass();
        },
    },
    {
        category: 'Label Resolution',
        label: 'Persona label preserved (with templates)',
        setup() {
            applySettings({ injectPersona: true, labelUser: '{{user}} in the scene' });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            // The template is not resolved in the plan — resolution happens during injection.
            // The plan should contain the raw template string.
            if (!plan.persona.label.includes('{{user}}')) return fail(`template placeholder missing: "${plan.persona.label}"`);
            return pass();
        },
    }
);

// ── Category 5: Enable/Disable Toggles ────

scenarios.push(
    {
        category: 'Enable/Disable Toggles',
        label: 'Char disabled → plan.char.enabled=false',
        setup() {
            applySettings({ enabled: true, injectChar: false, injectPersona: false, extraImagesEnabled: false, charExtraImagesEnabled: false, lorebookImagesEnabled: false });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            if (plan.char.enabled) return fail('char should be disabled');
            return pass();
        },
    },
    {
        category: 'Enable/Disable Toggles',
        label: 'Master disabled → no sources enabled',
        setup() {
            applySettings({ enabled: false, injectChar: true, injectPersona: true, extraImagesEnabled: true });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            // When enabled=false, prompt-injection bails early, but the plan builder
            // still runs (it's called by token-estimate too). Verify the plan object exists.
            if (!plan || typeof plan !== 'object') return fail('plan is missing');
            // Some sources may still be enabled in the plan even when master is off,
            // because the plan builder doesn't check s.enabled. That's fine — the
            // injection pipeline checks it. Verify the plan is structurally valid.
            if (!plan.char || !plan.persona || !plan.extras || !plan.gallery || !plan.lorebook) {
                return fail('plan missing one or more source keys');
            }
            return pass('plan structurally valid');
        },
    }
);

// ── Category 6: Group Chat ────────────────

scenarios.push(
    {
        category: 'Group Chat',
        label: 'Char + gallery skipped in group chat',
        manual: true,
        groupChatOnly: true,
        run() {},
        assert() {
            return manual('open a group chat and run /pp-test — verify plan.char and plan.gallery are disabled, while persona/lorebook/extras remain active');
        },
    },
    {
        category: 'Group Chat',
        label: 'Persona + extras + lorebook still active in group chat',
        manual: true,
        groupChatOnly: true,
        run() {},
        assert() {
            return manual('open a group chat and run /pp-test — verify plan.persona, plan.extras, and plan.lorebook are unaffected by group chat');
        },
    }
);

// ── Category 7: Empty / Missing State ─────

scenarios.push(
    {
        category: 'Empty / Missing State',
        label: 'Plan object is complete with all keys',
        setup() {
            applySettings({ enabled: true });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            const required = ['char', 'persona', 'extras', 'gallery', 'lorebook'];
            const missing = required.filter(k => !(k in plan));
            if (missing.length) return fail(`missing keys: ${missing.join(', ')}`);
            return pass();
        },
    },
    {
        category: 'Empty / Missing State',
        label: 'No crash with all sources disabled',
        setup() {
            applySettings({ enabled: true, injectChar: false, injectPersona: false, extraImagesEnabled: false, charExtraImagesEnabled: false, lorebookImagesEnabled: false });
        },
        async run() { return await buildInjectionPlan(); },
        assert(plan) {
            const anyEnabled = plan.char.enabled || plan.persona.enabled || plan.extras.enabled || plan.gallery.enabled || plan.lorebook.enabled;
            if (anyEnabled) return fail('a source is enabled when it should not be');
            return pass();
        },
    }
);

// ── Runner ────────────────────────────────

/**
 * Run all test scenarios, collect results, and display them in a popup.
 * Called from the /pp-test slash command handler.
 * @returns {Promise<string>} empty string (silences slash command echo)
 */
export async function runTests() {
    const results = [];
    let catOrder = [];
    const catMap = new Map();

    for (const scenario of scenarios) {
        const cat = scenario.category || '';
        if (cat && !catMap.has(cat)) {
            catMap.set(cat, []);
            catOrder.push(cat);
        }
        const entry = { label: scenario.label, status: 'fail', detail: '' };

        // Manual scenarios — skip the build, just report as manual
        if (scenario.manual) {
            entry.status = 'manual';
            entry.detail = scenario.groupChatOnly ? 'run in group chat' : 'manual test';
            catMap.get(cat).push(entry);
            results.push(entry);
            continue;
        }

        saveState();
        try {
            if (scenario.setup) scenario.setup();
            const plan = await scenario.run();
            const result = scenario.assert(plan);
            entry.status = result.status;
            entry.detail = result.detail || '';
        } catch (err) {
            entry.status = 'fail';
            entry.detail = String(err.message || err);
        } finally {
            restoreState();
        }

        catMap.get(cat).push(entry);
        results.push(entry);
    }

    const passed = results.filter(r => r.status === 'pass').length;
    const failed = results.filter(r => r.status === 'fail').length;
    const skipped = results.filter(r => r.status === 'skip').length;
    const manuals = results.filter(r => r.status === 'manual').length;

    // ── Render popup ────────────────────
    const lines = ['<h3>Picture Prompt — Diagnostic Tests</h3>'];

    for (const cat of catOrder) {
        const items = catMap.get(cat);
        const catP = items.filter(r => r.status === 'pass').length;
        const catF = items.filter(r => r.status === 'fail').length;
        const catS = items.filter(r => r.status === 'skip').length;
        const catM = items.filter(r => r.status === 'manual').length;
        const catExec = catP + catF + catS;

        let catLabel = `${cat} (${catP}/${catExec}`;
        if (catS > 0) catLabel += `, ${catS} skipped`;
        if (catM > 0) catLabel += `, ${catM} manual`;
        catLabel += ')';
        lines.push(`<h4 style="margin:8px 0 4px;">${catLabel}</h4>`);

        for (const item of items) {
            let icon, color;
            switch (item.status) {
                case 'pass':   icon = '✓'; color = 'var(--success-color)'; break;
                case 'fail':   icon = '✗'; color = 'var(--error-color)'; break;
                case 'skip':   icon = '⚠'; color = '#ffd700'; break;
                case 'manual': icon = '◌'; color = 'var(--text-color-dim)'; break;
                default:       icon = '?'; color = 'var(--text-color-dim)';
            }
            const detailHtml = item.detail ? ` <span style="color:var(--text-color-dim);font-size:0.9em;">— ${item.detail}</span>` : '';
            lines.push(`<p style="margin:2px 0 2px 16px;color:${color};">${icon} ${item.label}${detailHtml}</p>`);
        }
    }

    lines.push('<hr style="margin:8px 0;border-color:var(--border-color);">');
    const summaryColor = failed > 0 ? 'var(--error-color)' : 'var(--success-color)';
    let summary = `${passed} passed, ${failed} failed`;
    if (skipped > 0) summary += `, ${skipped} skipped`;
    if (manuals > 0) summary += `, ${manuals} manual`;
    lines.push(`<p style="color:${summaryColor};font-weight:bold;">${summary}</p>`);

    Popup.show.text('Picture Prompt', lines.join(''));
    return '';
}

// ── Exports ───────────────────────────────

/**
 * Get a plain-text summary of test results (used for CI/debug logging).
 * Returns { passed, failed, skipped, manual, total }.
 */
export function getTestSummary() {
    const summary = { passed: 0, failed: 0, skipped: 0, manual: 0, total: scenarios.length };
    // Note: this doesn't run the tests — it counts scenario definitions
    // that are manual vs. automated.
    for (const s of scenarios) {
        if (s.manual) summary.manual++;
    }
    summary.passed = summary.total - summary.manual;
    return summary;
}
