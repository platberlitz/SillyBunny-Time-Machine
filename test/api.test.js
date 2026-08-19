import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
    captureCharacter,
    captureEverything,
    capturePresets,
    hostSnapshotParts,
    liveLorebook,
    restoreCharacter,
    restorePreset,
} from '../src/api.js';
import { getSettings, MODULE_NAME } from '../src/store.js';

let context;
let files;
let persisted;
let requests;
let worldStatus;
let presetManager;
let cachedWorld;
let presetRows;

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

test.beforeEach(() => {
    const events = new EventEmitter();
    files = new Map();
    persisted = {};
    requests = [];
    worldStatus = 200;
    cachedWorld = null;
    presetRows = [{ name: 'Main', preset: { temperature: 1 } }];
    presetManager = { updateList() {} };
    context = {
        extensionSettings: {},
        eventSource: events,
        eventTypes: { SETTINGS_UPDATED: 'settings_updated', PRESET_CHANGED: 'preset_changed' },
        getRequestHeaders: () => ({ 'content-type': 'application/json' }),
        saveSettingsDebounced: () => {
            persisted = structuredClone(context.extensionSettings);
            queueMicrotask(() => events.emit('settings_updated'));
        },
        characters: [],
        tagMap: {},
        constants: { unset: '__UNSET__' },
        getCharacters: async () => {},
        unshallowCharacter: async () => {},
        getWorldInfoNames: () => [],
        loadWorldInfo: async () => cachedWorld,
        getPresetManager: () => presetManager,
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        if (url === '/api/settings/get') {
            return jsonResponse({
                settings: JSON.stringify({ extension_settings: persisted }),
                openai_setting_names: presetRows.map(row => row.name),
                openai_settings: presetRows.map(row => JSON.stringify(row.preset)),
            });
        }
        if (url === '/api/files/upload') {
            const path = `/user/files/${body.name}`;
            files.set(path, Buffer.from(body.data, 'base64').toString('utf8'));
            return jsonResponse({ path });
        }
        if (url === '/api/files/delete') {
            files.delete(body.path);
            return new Response('', { status: 200 });
        }
        if (typeof url === 'string' && url.startsWith('/user/files/')) {
            return files.has(url)
                ? new Response(files.get(url), { status: 200 })
                : new Response('', { status: 404 });
        }
        if (url === '/api/worldinfo/get') {
            requests.push({ url, body });
            return worldStatus === 200
                ? jsonResponse({ entries: {}, originalData: { name: body.name } })
                : new Response('', { status: worldStatus });
        }
        if (url === '/api/characters/merge-attributes') {
            requests.push({ url, body });
            return jsonResponse({});
        }
        if (url === '/api/presets/save') {
            requests.push({ url, body });
            return jsonResponse({ name: 'Safe_Name' });
        }
        throw new Error(`Unexpected request: ${url}`);
    };
});

test('character capture re-finds the avatar after an async list reorder', async () => {
    const a = { avatar: 'A.png', name: 'A', json_data: JSON.stringify({ name: 'A', value: 1 }) };
    const b = { avatar: 'B.png', name: 'B', json_data: JSON.stringify({ name: 'B', value: 2 }) };
    context.characters = [{ avatar: 'A.png', name: 'A' }, b];
    context.tagMap['A.png'] = ['favorite'];
    context.unshallowCharacter = async () => {
        context.characters = [b, a];
    };

    const row = await captureCharacter('A.png', { force: true });
    const payload = JSON.parse(files.get(row.url));
    assert.equal(payload.data.name, 'A');
    assert.deepEqual(payload.tags, ['favorite']);
});

test('manual capture ignores automatic toggles and continues after one failure', async () => {
    const settings = getSettings();
    settings.captureCharacters = false;
    settings.captureLorebooks = false;
    settings.capturePresets = false;
    context.characters = [{
        avatar: 'A.png',
        name: 'A',
        json_data: JSON.stringify({ name: 'A' }),
    }];
    context.getWorldInfoNames = () => ['Broken'];
    worldStatus = 500;

    const originalError = console.error;
    console.error = () => {};
    let result;
    try {
        result = await captureEverything();
    } finally {
        console.error = originalError;
    }

    assert.deepEqual(result, { taken: 2, skipped: 0, failed: 1 });
    assert.equal(files.size, 2);
});

test('only an explicit 404 means a lorebook is absent', async () => {
    worldStatus = 404;
    assert.equal(await liveLorebook('Missing'), null);
    worldStatus = 500;
    await assert.rejects(liveLorebook('Broken'), /responded 500/);
});

test('pending cached lorebook state takes precedence over disk', async () => {
    cachedWorld = { entries: { 1: { uid: 1, content: 'Unsaved' } } };
    worldStatus = 500;
    const book = await liveLorebook('Current');

    assert.deepEqual(book, cachedWorld);
    assert.equal(requests.some(request => request.url === '/api/worldinfo/get'), false);
});

test('character restore cannot let snapshot data override its target', async () => {
    await restoreCharacter(
        'A.png',
        { avatar: 'Wrong.png', name: 'Old' },
        { name: 'Current' },
        undefined,
    );
    assert.equal(requests[0].url, '/api/characters/merge-attributes');
    assert.equal(requests[0].body.avatar, 'A.png');
});

test('preset restore refreshes the live manager with the stored name', async () => {
    const updates = [];
    presetManager.updateList = (name, preset) => {
        updates.push({ name, preset });
        queueMicrotask(() => context.eventSource.emit('preset_changed', { apiId: 'openai' }));
    };
    const preset = { temperature: 0.5 };
    assert.equal(await restorePreset('openai', 'Unsafe/Name', preset), 'Safe_Name');
    assert.deepEqual(updates, [{ name: 'Safe_Name', preset }]);

    presetManager.updateList = () => { throw new Error('refresh failed'); };
    await assert.rejects(
        restorePreset('openai', 'Main', preset),
        error => error.partial === true && /refresh failed/.test(error.message),
    );
});

test('preset restore suppresses only the requested and canonical presets', async () => {
    let sweep;
    presetManager.updateList = (name) => {
        presetRows = [
            { name, preset: { temperature: 0.5 } },
            { name: 'Other', preset: { temperature: 0.7 } },
        ];
        sweep = capturePresets({ force: true });
        queueMicrotask(() => context.eventSource.emit('preset_changed', { apiId: 'openai' }));
    };

    await restorePreset('openai', 'Unsafe/Name', { temperature: 0.5 });
    assert.deepEqual(await sweep, { taken: 1, skipped: 1, failed: 0 });
    assert.equal(files.size, 1, 'the unrelated preset is still captured');
});

test('advanced preset restore keeps its embedded name aligned with the stored name', async () => {
    const updates = [];
    presetManager.updateList = (name, preset) => updates.push({ name, preset });
    const preset = { name: 'Old Name', template: 'Keep this' };

    assert.equal(await restorePreset('instruct', 'Unsafe/Name', preset), 'Safe_Name');
    const saves = requests.filter(request => request.url === '/api/presets/save');
    assert.equal(saves.length, 2);
    assert.equal(saves[0].body.preset.name, 'Unsafe/Name');
    assert.equal(saves[1].body.name, 'Safe_Name');
    assert.equal(saves[1].body.preset.name, 'Safe_Name');
    assert.deepEqual(updates, [{
        name: 'Safe_Name',
        preset: { name: 'Safe_Name', template: 'Keep this' },
    }]);
    assert.equal(preset.name, 'Old Name', 'the loaded snapshot is not mutated');
});

test('host backup picker excludes bookkeeping and malformed blocks', () => {
    const settings = JSON.parse(JSON.stringify({
        extension_settings: {
            GoodExtension: { enabled: true },
            [MODULE_NAME]: { snapshots: [] },
            character_attachments: { fake: [] },
            attachments: {},
            disabledExtensions: ['old'],
            constructor: { polluted: true },
        },
    }));
    assert.deepEqual(hostSnapshotParts(settings), [
        { kind: 'extension', key: 'GoodExtension', label: 'GoodExtension' },
    ]);
});
