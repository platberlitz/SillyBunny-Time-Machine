/**
 * The Time Machine popup: pick a thing, pick a version, see what changed, put it
 * back.
 *
 * Everything is written to the DOM with textContent. Snapshot payloads are the
 * user's own cards and books rather than a stranger's, but a diff view is
 * exactly where a card full of markup would get rendered by accident.
 */
import {
    captureEverything,
    hostSnapshotParts,
    listHostSnapshots,
    liveCharacterCard,
    liveLorebook,
    loadHostSnapshot,
    readAllPresets,
    restoreCharacter,
    restoreExtensionBlock,
    restoreLorebook,
    restorePreset,
} from './api.js';
import { diffFields, diffLorebook, formatBytes, formatWhen, sortSnapshots } from './core.js';
import { getSettings, listSnapshots, load, remove, saveSettings } from './store.js';

let openPopup = null;

function ctx() {
    return globalThis.SillyTavern.getContext();
}

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text) {
        node.textContent = text;
    }
    return node;
}

function button(className, label, onClick) {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
}

/** A value shown in a diff cell: short enough to read, long enough to recognise. */
function preview(value) {
    if (value === undefined) {
        return '(not set)';
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

const KIND_LABELS = { character: 'Characters', lorebook: 'Lorebooks', preset: 'Presets' };

export async function openTimeMachine() {
    if (openPopup) {
        return;
    }
    const context = ctx();
    const root = el('div', 'sbctm');
    const state = { selected: null, snapshot: null };

    // ---- header ----
    const actions = el('div', 'sbctm-actions');
    const status = el('span', 'sbctm-status');
    status.setAttribute('role', 'status');
    const snapshotNow = button('menu_button', 'Snapshot everything now', async () => {
        snapshotNow.disabled = true;
        try {
            const taken = await captureEverything(message => {
                status.textContent = message;
            });
            status.textContent = taken === 0
                ? 'Nothing has changed since the last snapshot.'
                : `Stored ${taken} new snapshot${taken === 1 ? '' : 's'}.`;
            renderTargets();
        } catch (error) {
            console.error('[Time Machine] snapshot failed', error);
            status.textContent = 'Could not finish the snapshot. See the console.';
        } finally {
            snapshotNow.disabled = false;
        }
    });
    actions.append(snapshotNow, status);
    root.append(actions);

    root.append(el('div', 'sbctm-hint',
        'Characters, lorebooks and presets are snapshotted here, because nothing in SillyBunny backs them up. '
        + 'Agents and other extensions\' settings live in settings.json, which the server already backs up on its own — those are further down.'));

    // ---- body ----
    const body = el('div', 'sbctm-body');
    const targets = el('div', 'sbctm-targets');
    const detail = el('div', 'sbctm-detail');
    body.append(targets, detail);
    root.append(body);

    function renderTargets() {
        targets.replaceChildren();
        const rows = listSnapshots();
        if (rows.length === 0) {
            targets.append(el('div', 'sbctm-empty',
                'No snapshots yet. Editing a character or lorebook takes one automatically, or use the button above.'));
            return;
        }

        const grouped = new Map();
        for (const row of rows) {
            const key = `${row.kind}:${row.target}`;
            const existing = grouped.get(key);
            if (!existing || row.ts > existing.ts) {
                grouped.set(key, row);
            }
        }

        for (const kind of ['character', 'lorebook', 'preset']) {
            const inKind = [...grouped.values()]
                .filter(row => row.kind === kind)
                .sort((a, b) => a.label.localeCompare(b.label));
            if (inKind.length === 0) {
                continue;
            }
            targets.append(el('div', 'sbctm-group', KIND_LABELS[kind]));
            for (const row of inKind) {
                const count = rows.filter(r => r.kind === row.kind && r.target === row.target).length;
                const item = button('sbctm-target', '', () => selectTarget(row.kind, row.target));
                item.append(
                    el('span', 'sbctm-target-name', row.label),
                    el('span', 'sbctm-target-meta', `${count} version${count === 1 ? '' : 's'} · ${formatWhen(row.ts)}`),
                );
                if (state.selected?.kind === row.kind && state.selected?.target === row.target) {
                    item.classList.add('sbctm-target-current');
                }
                targets.append(item);
            }
        }
    }

    function selectTarget(kind, target) {
        state.selected = { kind, target };
        state.snapshot = null;
        renderTargets();
        renderTimeline();
    }

    function renderTimeline() {
        detail.replaceChildren();
        if (!state.selected) {
            detail.append(el('div', 'sbctm-empty', 'Pick something on the left to see its history.'));
            return;
        }

        const { kind, target } = state.selected;
        const rows = sortSnapshots(listSnapshots().filter(r => r.kind === kind && r.target === target));
        detail.append(el('h4', 'sbctm-heading', rows[0]?.label ?? target));

        const list = el('div', 'sbctm-timeline');
        for (const row of rows) {
            const entry = el('div', 'sbctm-version');
            entry.append(el('span', 'sbctm-version-when', formatWhen(row.ts)));
            entry.append(el('span', 'sbctm-version-size', formatBytes(row.size)));
            entry.append(button('menu_button sbctm-small', 'Compare', () => showComparison(row)));
            entry.append(button('menu_button sbctm-small', 'Delete', async () => {
                await remove(row);
                if (listSnapshots().some(r => r.kind === kind && r.target === target)) {
                    renderTimeline();
                } else {
                    state.selected = null;
                    renderTimeline();
                }
                renderTargets();
            }));
            list.append(entry);
        }
        detail.append(list);
    }

    async function currentStateOf(kind, target) {
        if (kind === 'character') {
            return liveCharacterCard(target);
        }
        if (kind === 'lorebook') {
            return liveLorebook(target);
        }
        const [apiId, ...rest] = target.split('/');
        const name = rest.join('/');
        const found = (await readAllPresets()).find(p => p.apiId === apiId && p.name === name);
        return found?.preset ?? null;
    }

    async function showComparison(row) {
        detail.replaceChildren(el('div', 'sbctm-empty', 'Reading that version...'));
        let payload;
        let live;
        try {
            payload = await load(row);
            live = await currentStateOf(row.kind, row.target);
        } catch (error) {
            console.error('[Time Machine] could not compare', error);
            detail.replaceChildren(el('div', 'sbctm-empty', 'That version could not be read.'));
            return;
        }

        state.snapshot = { row, payload, live };
        detail.replaceChildren();
        detail.append(el('h4', 'sbctm-heading', `${row.label} — ${formatWhen(row.ts)}`));

        if (live === null) {
            detail.append(el('div', 'sbctm-warn',
                row.kind === 'character'
                    ? 'This character is not in your collection any more. Restoring needs the card file itself, which this extension does not store — only its fields.'
                    : 'This no longer exists. Restoring will create it again.'));
        }

        detail.append(row.kind === 'lorebook'
            ? lorebookDiff(live, payload.data)
            : fieldDiff(live, payload.data));

        const bar = el('div', 'sbctm-bar');
        const restore = button('menu_button', 'Restore this version', () => confirmRestore(row, payload, live));
        if (row.kind === 'character' && live === null) {
            restore.disabled = true;
        }
        bar.append(restore, button('menu_button', 'Back', () => renderTimeline()));
        detail.append(bar);
    }

    function fieldDiff(live, snapshot) {
        // Snapshot on the right: the question is "what would restoring change",
        // so the current state is the starting point and the snapshot is the end.
        const rows = diffFields(live ?? {}, snapshot ?? {});
        if (rows.length === 0) {
            return el('div', 'sbctm-empty', 'Identical to what is there now.');
        }
        const table = el('table', 'sbctm-diff');
        for (const change of rows) {
            const tr = el('tr', `sbctm-${change.kind}`);
            tr.append(el('td', 'sbctm-diff-key', change.key));
            tr.append(el('td', 'sbctm-diff-from', preview(change.from)));
            tr.append(el('td', 'sbctm-diff-to', preview(change.to)));
            table.append(tr);
        }
        const wrapper = el('div', 'sbctm-diff-wrap');
        wrapper.append(el('div', 'sbctm-diff-legend', 'Left: as it is now. Right: as it was in this version.'), table);
        return wrapper;
    }

    function lorebookDiff(live, snapshot) {
        const { added, removed, changed } = diffLorebook(live ?? {}, snapshot ?? {});
        if (added.length + removed.length + changed.length === 0) {
            return el('div', 'sbctm-empty', 'Identical to what is there now.');
        }
        const wrapper = el('div', 'sbctm-diff-wrap');
        wrapper.append(el('div', 'sbctm-diff-legend',
            `Restoring would bring back ${added.length}, remove ${removed.length} and change ${changed.length} entr${changed.length === 1 ? 'y' : 'ies'}.`));
        const table = el('table', 'sbctm-diff');
        for (const entry of added) {
            const tr = el('tr', 'sbctm-added');
            tr.append(el('td', 'sbctm-diff-key', 'Comes back'), el('td', '', entry.title), el('td', ''));
            table.append(tr);
        }
        for (const entry of removed) {
            const tr = el('tr', 'sbctm-removed');
            tr.append(el('td', 'sbctm-diff-key', 'Goes away'), el('td', '', entry.title), el('td', ''));
            table.append(tr);
        }
        for (const entry of changed) {
            const tr = el('tr', 'sbctm-changed');
            tr.append(
                el('td', 'sbctm-diff-key', 'Changes'),
                el('td', '', entry.title),
                el('td', '', entry.fields.map(field => field.key).join(', ')),
            );
            table.append(tr);
        }
        wrapper.append(table);
        return wrapper;
    }

    async function confirmRestore(row, payload, live) {
        const ok = await context.Popup.show.confirm(
            'Restore this version?',
            `${row.label} will be put back as it was ${formatWhen(row.ts)}. `
            + 'A snapshot of how it is right now is taken first, so this can be undone.',
        );
        if (!ok) {
            return;
        }

        status.textContent = 'Restoring...';
        try {
            // Taking the "before" snapshot first is what makes a restore safe to
            // try. Without it, restoring is itself an unrecoverable edit.
            await snapshotBeforeRestore(row, live);

            if (row.kind === 'character') {
                await restoreCharacter(row.target, payload.data, live ?? {}, payload.tags);
            } else if (row.kind === 'lorebook') {
                await restoreLorebook(row.target, payload.data);
            } else {
                const [apiId, ...rest] = row.target.split('/');
                await restorePreset(apiId, rest.join('/'), payload.data);
            }

            status.textContent = `${row.label} restored.`;
            globalThis.toastr?.success(`${row.label} restored.`);
            renderTargets();
            renderTimeline();
        } catch (error) {
            console.error('[Time Machine] restore failed', error);
            status.textContent = 'The restore failed. Nothing was changed. See the console.';
            globalThis.toastr?.error('The restore failed.');
        }
    }

    async function snapshotBeforeRestore(row, live) {
        if (live === null) {
            return;
        }
        const { save } = await import('./store.js');
        await save({ kind: row.kind, target: row.target, label: row.label, data: live });
    }

    // ---- the host's own settings backups ----
    root.append(hostBackupsSection());

    renderTargets();
    renderTimeline();

    openPopup = new context.Popup(root, context.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        okButton: 'Close',
        onClose: () => {
            openPopup = null;
        },
    });
    await openPopup.show();
    openPopup = null;
}

/**
 * Presets are ours to restore, but agents and other extensions' settings live in
 * settings.json — which the server already backs up. This lifts one block out of
 * a past copy rather than duplicating the capture.
 */
function hostBackupsSection() {
    const section = el('details', 'sbctm-host');
    section.append(el('summary', '', 'Restore an extension\'s settings from SillyBunny\'s own backups'));
    const inner = el('div', 'sbctm-host-body');
    section.append(inner);
    inner.append(el('div', 'sbctm-hint',
        'SillyBunny copies settings.json into its backup folder whenever it changes, at most once every ten minutes, and keeps the last fifty. '
        + 'Agents, tags and every extension\'s settings are in there — including whatever an "Update All" overwrote. '
        + 'Only the one block you choose is written back; the rest of your settings are left alone.'));

    let loaded = false;
    section.addEventListener('toggle', async () => {
        if (!section.open || loaded) {
            return;
        }
        loaded = true;
        const picker = el('div', 'sbctm-host-picker');
        inner.append(picker);
        try {
            const backups = await listHostSnapshots();
            if (backups.length === 0) {
                picker.append(el('div', 'sbctm-empty', 'SillyBunny has not written a settings backup yet.'));
                return;
            }
            const select = el('select', 'text_pole');
            for (const backup of backups) {
                const option = el('option', '', `${formatWhen(backup.date)} · ${formatBytes(backup.size)}`);
                option.value = backup.name;
                select.append(option);
            }
            const parts = el('div', 'sbctm-host-parts');
            picker.append(select, button('menu_button', 'Open this backup', async () => {
                parts.replaceChildren(el('div', 'sbctm-empty', 'Reading...'));
                try {
                    const settings = await loadHostSnapshot(select.value);
                    renderParts(parts, settings);
                } catch (error) {
                    console.error('[Time Machine] could not read the backup', error);
                    parts.replaceChildren(el('div', 'sbctm-empty', 'That backup could not be read.'));
                }
            }), parts);
        } catch (error) {
            console.error('[Time Machine] could not list backups', error);
            picker.append(el('div', 'sbctm-empty', 'The backup list could not be read.'));
        }
    });

    return section;
}

function renderParts(host, settings) {
    host.replaceChildren();
    const parts = hostSnapshotParts(settings);
    if (parts.length === 0) {
        host.append(el('div', 'sbctm-empty', 'That backup has no extension settings in it.'));
        return;
    }
    for (const part of parts) {
        const stored = settings.extension_settings[part.key];
        const rows = diffFields(ctx().extensionSettings[part.key] ?? {}, stored ?? {});
        const line = el('div', 'sbctm-host-part');
        line.append(el('span', 'sbctm-target-name', part.label));
        line.append(el('span', 'sbctm-target-meta',
            rows.length === 0 ? 'Same as now' : `${rows.length} setting${rows.length === 1 ? '' : 's'} differ`));
        if (rows.length > 0) {
            line.append(button('menu_button sbctm-small', 'Restore this block', async () => {
                const ok = await ctx().Popup.show.confirm(
                    `Restore ${part.label}?`,
                    'That extension\'s settings will be replaced with the version in this backup. '
                    + 'Extensions read their settings once when the page loads, so reload SillyBunny afterwards for it to take effect.',
                );
                if (!ok) {
                    return;
                }
                restoreExtensionBlock(part.key, stored);
                globalThis.toastr?.success(`${part.label} restored. Reload the page for it to take effect.`);
            }));
        }
        host.append(line);
    }
}

export async function closeTimeMachine() {
    if (openPopup) {
        const popup = openPopup;
        openPopup = null;
        popup.completeCancelled?.();
    }
}

/** Retention settings, shown in the extensions drawer rather than the popup. */
export function renderDrawer(hostElement) {
    const settings = getSettings();
    hostElement.replaceChildren();

    for (const [key, label] of [
        ['captureCharacters', 'Snapshot characters when they are edited'],
        ['captureLorebooks', 'Snapshot lorebooks when they are saved'],
        ['capturePresets', 'Snapshot presets at startup and when you switch preset'],
    ]) {
        const wrapper = el('label', 'checkbox_label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!settings[key];
        box.addEventListener('change', () => {
            settings[key] = box.checked;
            saveSettings();
        });
        wrapper.append(box, el('span', '', label));
        hostElement.append(wrapper);
    }

    const keep = el('label', 'sbctm-field');
    keep.append(el('span', '', 'Versions kept per item'));
    const keepInput = document.createElement('input');
    keepInput.type = 'number';
    keepInput.className = 'text_pole';
    keepInput.min = '1';
    keepInput.value = String(settings.keepPerTarget);
    keepInput.addEventListener('change', () => {
        const value = Number.parseInt(keepInput.value, 10);
        if (Number.isFinite(value) && value >= 1) {
            settings.keepPerTarget = value;
            saveSettings();
        } else {
            keepInput.value = String(settings.keepPerTarget);
        }
    });
    keep.append(keepInput);
    hostElement.append(keep);

    const used = listSnapshots().reduce((sum, row) => sum + (row.size ?? 0), 0);
    hostElement.append(el('div', 'sbctm-hint',
        `${listSnapshots().length} snapshots, ${formatBytes(used)} of a ${formatBytes(settings.maxTotalBytes)} budget. `
        + 'Snapshots are files on the server, so they are included in whatever backs up your SillyBunny data directory.'));
}
