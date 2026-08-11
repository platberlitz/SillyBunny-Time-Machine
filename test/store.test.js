import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
    MODULE_NAME,
    commitSettings,
    getSettings,
    listSnapshots,
    load,
    pinSnapshots,
    prune,
    reconcile,
    remove,
    renameTarget,
    save,
    unpinSnapshots,
} from '../src/store.js';
import { legacyHashOf } from '../src/core.js';

let context;
let persisted;
let files;
let requests;
let deleteStatus;

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

test.beforeEach(() => {
    const events = new EventEmitter();
    persisted = {};
    files = new Map();
    requests = [];
    deleteStatus = null;
    context = {
        extensionSettings: {},
        eventSource: events,
        eventTypes: { SETTINGS_UPDATED: 'settings_updated' },
        getRequestHeaders: () => ({ 'content-type': 'application/json' }),
        saveSettingsDebounced: () => {
            persisted = structuredClone(context.extensionSettings);
            requests.push(`commit:${persisted[MODULE_NAME]?.snapshots?.length ?? 0}`);
            queueMicrotask(() => events.emit('settings_updated'));
        },
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async (url, options = {}) => {
        if (url === '/api/settings/get') {
            return jsonResponse({ settings: JSON.stringify({ extension_settings: persisted }) });
        }
        if (url === '/api/files/upload') {
            const body = JSON.parse(options.body);
            const path = `/files/${body.name}`;
            files.set(path, Buffer.from(body.data, 'base64').toString('utf8'));
            requests.push(`upload:${body.name}`);
            return jsonResponse({ path: path.slice(1) });
        }
        if (url === '/api/files/delete') {
            const { path } = JSON.parse(options.body);
            requests.push(`delete:${path}`);
            if (deleteStatus) {
                return new Response('', { status: deleteStatus });
            }
            if (!files.delete(path)) {
                return new Response('', { status: 404 });
            }
            return new Response('', { status: 200 });
        }
        if (typeof url === 'string' && url.startsWith('/files/')) {
            return files.has(url)
                ? new Response(files.get(url), { status: 200, headers: { 'content-type': 'application/json' } })
                : new Response('', { status: 404 });
        }
        throw new Error(`Unexpected request: ${url}`);
    };
});

test('malformed settings are repaired into a plain module block', () => {
    context.extensionSettings[MODULE_NAME] = [];
    const settings = getSettings();
    assert.equal(Array.isArray(settings), false);
    assert.deepEqual(settings.snapshots, []);
    assert.equal(settings.keepPerTarget, 15);
});

test('a new index is committed before retention deletes the old file', async () => {
    getSettings().keepPerTarget = 1;
    const old = await save({ kind: 'character', target: 'Ren.png', label: 'Ren', data: { name: 'Old' } });
    const current = await save({ kind: 'character', target: 'Ren.png', label: 'Ren', data: { name: 'Current' } });

    assert.notEqual(old.id, current.id);
    assert.deepEqual(listSnapshots().map(row => row.id), [current.id]);
    assert.equal(files.has(old.url), false);
    assert.equal(files.has(current.url), true);
    const upload = requests.findIndex(item => item === `upload:${current.name}`);
    const durable = requests.findIndex((item, index) => index > upload && item === 'commit:2');
    const deletion = requests.findIndex(item => item === `delete:${old.url}`);
    assert.ok(upload < durable && durable < deletion, requests.join('\n'));
});

test('an untrusted file path is quarantined and never deleted', async () => {
    context.extensionSettings[MODULE_NAME] = {
        ...getSettings(),
        snapshots: [{
            id: 'bad', kind: 'character', target: 'Ren.png', label: 'Ren',
            ts: 1, size: 1, hash: '0'.repeat(64),
            name: 'cardtm_character_Ren_1.json', url: '/files/important.txt',
        }],
    };
    persisted = structuredClone(context.extensionSettings);

    assert.equal(getSettings().snapshots.length, 0);
    assert.equal(getSettings().quarantinedSnapshots.length, 1);
    await reconcile();
    assert.equal(requests.some(item => item.startsWith('delete:')), false);
});

test('a mismatched or tampered payload cannot be loaded', async () => {
    const row = await save({ kind: 'lorebook', target: 'World', label: 'World', data: { entries: {} } });
    const payload = JSON.parse(files.get(row.url));
    payload.target = 'Other';
    files.set(row.url, JSON.stringify(payload));
    await assert.rejects(load(row), /does not match/);

    payload.target = 'World';
    payload.data.entries = { 1: { uid: 1 } };
    files.set(row.url, JSON.stringify(payload));
    await assert.rejects(load(row), /integrity/);
    assert.equal(listSnapshots().length, 1, 'corrupt evidence remains indexed');
});

test('a transient delete failure retains the file index', async () => {
    const row = await save({ kind: 'preset', target: 'openai/Main', label: 'Main', data: { value: 1 } });
    deleteStatus = 500;
    await assert.rejects(remove(row), /responded 500/);
    assert.equal(listSnapshots().length, 1);
    assert.equal(persisted[MODULE_NAME].snapshots.length, 1);
});

test('an already-missing file can be removed from the index', async () => {
    const row = await save({ kind: 'preset', target: 'openai/Main', label: 'Main', data: { value: 1 } });
    files.delete(row.url);
    await remove(row);
    assert.equal(listSnapshots().length, 0);
    assert.equal(persisted[MODULE_NAME].snapshots.length, 0);
});

test('deduplication replaces a missing newest blob', async () => {
    const old = await save({ kind: 'character', target: 'Ren.png', label: 'Ren', data: { name: 'Ren' } });
    files.delete(old.url);
    const replacement = await save({ kind: 'character', target: 'Ren.png', label: 'Ren', data: { name: 'Ren' } });
    assert.notEqual(replacement.id, old.id);
    assert.deepEqual(listSnapshots().map(row => row.id), [replacement.id]);
    assert.equal(files.has(replacement.url), true);
});

test('a stale tab is stopped before it uploads a blob', async () => {
    const local = structuredClone(getSettings());
    persisted[MODULE_NAME] = { ...local, lastCommit: 'another-tab' };
    await assert.rejects(
        save({ kind: 'character', target: 'Ren.png', label: 'Ren', data: { name: 'Ren' } }),
        /another tab/,
    );
    assert.equal(requests.some(item => item.startsWith('upload:')), false);
});

test('snapshots written with the legacy JSON hash still load', async () => {
    const data = { z: 1, nested: { b: 2, a: 1 } };
    const payload = {
        format: 1,
        kind: 'character',
        target: 'Ren.png',
        label: 'Ren',
        ts: 1,
        data,
    };
    const text = JSON.stringify(payload);
    const name = 'cardtm_character_Ren_1.json';
    const row = {
        id: name,
        kind: 'character',
        target: 'Ren.png',
        label: 'Ren',
        ts: 1,
        size: new TextEncoder().encode(text).length,
        hash: await legacyHashOf(data),
        name,
        url: `/files/${name}`,
    };
    context.extensionSettings[MODULE_NAME] = { ...getSettings(), snapshots: [row] };
    persisted = structuredClone(context.extensionSettings);
    files.set(row.url, text);

    assert.deepEqual((await load(listSnapshots()[0])).data, data);
});

test('an unconfirmed commit keeps a possibly indexed blob and row', async () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    context.saveSettingsDebounced = () => {
        persisted = structuredClone(context.extensionSettings);
        now = 20_000;
        queueMicrotask(() => context.eventSource.emit('settings_updated'));
    };
    try {
        await assert.rejects(
            save({ kind: 'character', target: 'Ren.png', label: 'Ren', data: { name: 'Ren' } }),
            error => error.code === 'COMMIT_UNCONFIRMED',
        );
    } finally {
        Date.now = originalNow;
    }

    assert.equal(listSnapshots().length, 1);
    assert.equal(persisted[MODULE_NAME].snapshots.length, 1);
    assert.equal(files.size, 1);
});

test('a synchronous settings failure restores the local commit token', async () => {
    const previous = getSettings().lastCommit;
    context.saveSettingsDebounced = () => { throw new Error('settings unavailable'); };

    await assert.rejects(
        save({ kind: 'character', target: 'Ren.png', label: 'Ren', data: { name: 'Ren' } }),
        /settings unavailable/,
    );
    assert.equal(getSettings().lastCommit, previous);
    assert.equal(listSnapshots().length, 0);
    assert.equal(files.size, 0);
});

test('a stale prune fails before deleting any blob', async () => {
    getSettings().keepPerTarget = 1;
    const old = await save(
        { kind: 'character', target: 'Ren.png', label: 'Ren', data: { name: 'Old' } },
        { skipPrune: true },
    );
    const current = await save(
        { kind: 'character', target: 'Ren.png', label: 'Ren', data: { name: 'Current' } },
        { skipPrune: true },
    );
    persisted[MODULE_NAME].lastCommit = 'another-tab';
    const deletes = requests.filter(item => item.startsWith('delete:')).length;

    await assert.rejects(prune(), /another tab/);
    assert.equal(requests.filter(item => item.startsWith('delete:')).length, deletes);
    assert.equal(files.has(old.url), true);
    assert.equal(files.has(current.url), true);
    assert.equal(listSnapshots().length, 2);
});

test('rename preserves labels and rolls back normalized rows on failure', async () => {
    await save({ kind: 'character', target: 'Old.png', label: 'Display Name', data: { name: 'Ren' } });
    await renameTarget('character', 'Old.png', 'New.png');
    assert.equal(listSnapshots()[0].label, 'Display Name');

    const originalFetch = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = async (url, options) => {
        if (url === '/api/settings/get' && ++reads === 2) {
            const stale = structuredClone(persisted);
            stale[MODULE_NAME].lastCommit = 'another-tab';
            return jsonResponse({ settings: JSON.stringify({ extension_settings: stale }) });
        }
        return originalFetch(url, options);
    };
    try {
        await assert.rejects(renameTarget('character', 'New.png', 'Final.png'), /another tab/);
    } finally {
        globalThis.fetch = originalFetch;
    }

    const row = listSnapshots()[0];
    assert.equal(row.target, 'New.png');
    assert.equal(row.label, 'Display Name');
    assert.equal(row.sourceTarget, 'Old.png');
});

test('pinned restore inputs survive unrelated retention', async () => {
    getSettings().keepPerTarget = 1;
    const old = await save(
        { kind: 'character', target: 'Ren.png', label: 'Ren', data: { name: 'Old' } },
        { skipPrune: true },
    );
    const current = await save(
        { kind: 'character', target: 'Ren.png', label: 'Ren', data: { name: 'Current' } },
        { skipPrune: true },
    );
    pinSnapshots([old.id]);
    try {
        await prune();
        assert.equal(listSnapshots().length, 2);
    } finally {
        unpinSnapshots([old.id]);
    }
    await prune();
    assert.deepEqual(listSnapshots().map(row => row.id), [current.id]);
});

test('a pinned restore input cannot be manually deleted', async () => {
    const row = await save(
        { kind: 'character', target: 'Ren.png', label: 'Ren', data: { name: 'Old' } },
        { skipPrune: true },
    );
    pinSnapshots([row.id]);
    try {
        await assert.rejects(remove(row), /in use by a restore/);
        assert.equal(files.has(row.url), true);
        assert.equal(listSnapshots().length, 1);
    } finally {
        unpinSnapshots([row.id]);
    }
});

test('settings changes and captures share one mutation queue', async () => {
    getSettings().captureCharacters = false;
    let releaseFirstCommit;
    let first = true;
    context.saveSettingsDebounced = () => {
        const snapshot = structuredClone(context.extensionSettings);
        if (first) {
            first = false;
            releaseFirstCommit = () => {
                persisted = snapshot;
                context.eventSource.emit('settings_updated');
            };
            return;
        }
        persisted = snapshot;
        queueMicrotask(() => context.eventSource.emit('settings_updated'));
    };

    const settingCommit = commitSettings();
    while (!releaseFirstCommit) {
        await new Promise(resolve => setImmediate(resolve));
    }
    const capture = save({ kind: 'character', target: 'Ren.png', label: 'Ren', data: { name: 'Ren' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.some(item => item.startsWith('upload:')), false);

    releaseFirstCommit();
    await settingCommit;
    const row = await capture;
    assert.equal(files.has(row.url), true);
    assert.equal(listSnapshots().length, 1);
});
