/**
 * Where snapshots live.
 *
 * Blobs go to the host's file store (POST /api/files/upload), which is the only
 * place a browser extension can put megabytes on the server. The index — a few
 * dozen bytes per snapshot — goes in extension settings, because every write
 * there re-serialises the whole of settings.json and copies it into the backup
 * folder on a timer. Snapshots in settings.json would make that copy grow with
 * the history it is supposed to be independent of.
 */
import { DEFAULT_KEEP_PER_TARGET, DEFAULT_MAX_TOTAL_BYTES, hashOf, prunePlan, snapshotFileName } from './core.js';

export const MODULE_NAME = 'SillyBunnyCardTimeMachine';
const SETTINGS_VERSION = 1;

/**
 * Data Maid offers to delete anything in the files directory that nothing
 * refers to, and it reads `character_attachments` as a map of arrays without
 * caring what the keys mean. The Data Bank UI, meanwhile, only ever renders the
 * array under the CURRENT character's avatar filename. A key that is not any
 * character's avatar therefore keeps Data Maid satisfied while staying out of
 * the user's attachment list, which is where these belong: they are this
 * extension's bookkeeping, not files the user attached to anything.
 *
 * ponytail: if the host ever validates that key against real characters, move
 * the registrations to the global `attachments` array and accept that snapshots
 * become visible in the Data Bank.
 *
 * The key keeps the extension's original name, as does MODULE_NAME below. Both
 * are storage keys: renaming one orphans every registration written under the
 * old one, which is how you get snapshots Data Maid offers to delete.
 */
const ATTACHMENT_KEY = '__SillyBunny-Card-Time-Machine__';

function ctx() {
    return globalThis.SillyTavern.getContext();
}

function defaults() {
    return {
        settingsVersion: SETTINGS_VERSION,
        snapshots: [],
        captureCharacters: true,
        captureLorebooks: true,
        capturePresets: true,
        keepPerTarget: DEFAULT_KEEP_PER_TARGET,
        maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
    };
}

export function getSettings() {
    const container = ctx().extensionSettings;
    if (!container[MODULE_NAME] || typeof container[MODULE_NAME] !== 'object') {
        container[MODULE_NAME] = defaults();
    }
    const settings = container[MODULE_NAME];
    if (!Array.isArray(settings.snapshots)) {
        settings.snapshots = [];
    }
    for (const [key, value] of Object.entries(defaults())) {
        if (typeof settings[key] !== typeof value || settings[key] === null) {
            settings[key] = value;
        }
    }
    settings.settingsVersion = SETTINGS_VERSION;
    return settings;
}

export function saveSettings() {
    ctx().saveSettingsDebounced();
}

export function listSnapshots() {
    return getSettings().snapshots;
}

/** The hash of the newest snapshot of a target, or null if there is none. */
export function lastHashOf(kind, target) {
    const matches = listSnapshots().filter(s => s.kind === kind && s.target === target);
    if (matches.length === 0) {
        return null;
    }
    return matches.reduce((newest, s) => (s.ts > newest.ts ? s : newest)).hash;
}

async function post(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`${url} responded ${response.status}`);
    }
    return response;
}

/**
 * Saves run one at a time.
 *
 * "Is this the same as last time" is answered from the index, and the index is
 * only written at the end of a save. Two captures of the same thing in flight at
 * once therefore both read an empty history and both store a copy — which is
 * exactly what happens when startup and a preset switch land together. Snapshots
 * are not on any hot path, so a single queue is cheaper than reasoning about
 * which pairs can overlap.
 */
let queue = Promise.resolve();

export function save(request) {
    const run = queue.then(() => saveNow(request), () => saveNow(request));
    // The queue itself must not inherit a rejection, or one failed capture stops
    // every later one.
    queue = run.then(() => {}, () => {});
    return run;
}

/**
 * Stores one snapshot, unless it is byte-identical to the previous one for the
 * same target.
 *
 * @returns {Promise<object|null>} the index row, or null when nothing changed.
 */
async function saveNow({ kind, target, label, data, extra = {} }) {
    const payload = { format: 1, kind, target, label, ts: Date.now(), data, ...extra };
    const hash = await hashOf(payload.data);
    if (hash === lastHashOf(kind, target)) {
        return null;
    }

    const settings = getSettings();
    const text = JSON.stringify(payload);
    const name = snapshotFileName(kind, target, payload.ts, settings.snapshots.map(s => s.name));

    const response = await post('/api/files/upload', {
        name,
        // btoa needs latin1, and card text is not. Encode first, then map bytes.
        data: base64(text),
    });
    const { path } = await response.json();

    const row = {
        id: `${kind}:${target}:${payload.ts}`,
        ts: payload.ts,
        kind,
        target,
        label,
        name,
        url: path,
        hash,
        size: new TextEncoder().encode(text).length,
    };
    settings.snapshots.push(row);
    registerAttachment(row);
    saveSettings();

    await prune();
    return row;
}

/**
 * The stored payload behind an index row.
 *
 * A row whose file is gone is dropped rather than left in the timeline. The two
 * can drift apart in ordinary use: settings.json is written on a debounce, so a
 * browser closed at the wrong moment leaves rows for files that were deleted,
 * and a restored settings.json brings back rows for files that no longer exist.
 * Offering a version that can never be restored is worse than not listing it.
 */
export async function load(row) {
    const response = await fetch(`/${row.url}`.replace(/^\/+/, '/'), { cache: 'no-store' });
    if (response.status === 404) {
        forget(row);
        throw new Error(`Snapshot ${row.name} is no longer on the server`);
    }
    if (!response.ok) {
        throw new Error(`Could not read snapshot ${row.name} (${response.status})`);
    }
    return response.json();
}

/** Drops an index row without trying to delete a file behind it. */
function forget(row) {
    const settings = getSettings();
    settings.snapshots = settings.snapshots.filter(s => s.id !== row.id);
    unregisterAttachment(row);
    saveSettings();
}

export async function remove(row) {
    try {
        await post('/api/files/delete', { path: row.url });
    } catch (error) {
        // A blob that is already gone must not strand its index row, or the
        // timeline offers a restore that can never work.
        console.warn('[Time Machine] could not delete snapshot file', row.name, error);
    }
    forget(row);
}

/** Applies the retention settings. Called after every successful capture. */
export async function prune() {
    const settings = getSettings();
    const doomed = new Set(prunePlan(settings.snapshots, {
        keepPerTarget: settings.keepPerTarget,
        maxTotalBytes: settings.maxTotalBytes,
    }));
    for (const row of settings.snapshots.filter(s => doomed.has(s.id))) {
        await remove(row);
    }
    return doomed.size;
}

function attachments() {
    const container = ctx().extensionSettings;
    if (!container.character_attachments || typeof container.character_attachments !== 'object') {
        container.character_attachments = {};
    }
    if (!Array.isArray(container.character_attachments[ATTACHMENT_KEY])) {
        container.character_attachments[ATTACHMENT_KEY] = [];
    }
    return container.character_attachments[ATTACHMENT_KEY];
}

function registerAttachment(row) {
    attachments().push({ url: row.url, size: row.size, name: row.name, created: row.ts });
}

function unregisterAttachment(row) {
    const list = attachments();
    const index = list.findIndex(entry => entry?.url === row.url);
    if (index !== -1) {
        list.splice(index, 1);
    }
}

function base64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    // Chunked: spreading a multi-megabyte array into String.fromCharCode blows
    // the argument limit, and a snapshot is exactly the size that reaches it.
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return globalThis.btoa(binary);
}
