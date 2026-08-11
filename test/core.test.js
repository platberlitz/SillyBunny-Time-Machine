import test from 'node:test';
import assert from 'node:assert/strict';

import {
    cardFromCharacter,
    diffFields,
    diffLorebook,
    entryTitle,
    hashOf,
    prunePlan,
    restorePayload,
    slug,
    snapshotFileName,
} from '../src/core.js';

const UNSET = '__@@UNSET@@__';

// ---------------------------------------------------------------- naming ---

test('snapshot filenames satisfy the host upload route', () => {
    // validateAssetFileName allows only [A-Za-z0-9_-.] and rejects a leading dot.
    const allowed = /^[a-zA-Z0-9_\-.]+$/;
    const awkward = ['Seraphina.png', 'My World / Book #2', 'ünïcødé', '   ', '../../etc/passwd', ''];
    for (const target of awkward) {
        const name = snapshotFileName('lorebook', target, 1700000000000);
        assert.match(name, allowed, target);
        assert.ok(!name.startsWith('.'), target);
        assert.ok(name.endsWith('.json'), target);
    }
});

test('a name already in use gets a suffix rather than overwriting', () => {
    const first = snapshotFileName('character', 'Ren', 5);
    const second = snapshotFileName('character', 'Ren', 5, [first]);
    const third = snapshotFileName('character', 'Ren', 5, [first, second]);
    assert.notEqual(first, second);
    assert.notEqual(second, third);
});

test('slugging keeps names recognisable and never empties out', () => {
    assert.equal(slug('Seraphina.png'), 'Seraphina');
    assert.equal(slug('My World / Book #2'), 'My-World-Book-2');
    assert.equal(slug('///'), 'unnamed');
});

// ----------------------------------------------------------------- cards ---

test('a card is read from json_data, without the fields the server adds', async () => {
    const card = cardFromCharacter({
        avatar: 'Ren.png',
        shallow: false,
        date_added: 123,
        chat_size: 456,
        data_size: 789,
        chat: 'Ren - 2026-01-01',
        json_data: JSON.stringify({
            name: 'Ren',
            description: 'A knight.',
            chat: 'Ren - 2025-12-01',
            spec: 'chara_card_v2',
            data: { name: 'Ren', description: 'A knight.' },
        }),
    });

    assert.deepEqual(Object.keys(card).sort(), ['data', 'description', 'name', 'spec']);
    // `chat` is sidecar-owned now, so the card's copy is stale and restoring it
    // would point the character at whatever was open when the snapshot ran.
    assert.equal(card.chat, undefined);
    await assert.doesNotReject(hashOf(card));
});

test('a shallow character is refused rather than snapshotted empty', () => {
    assert.equal(cardFromCharacter({ avatar: 'Ren.png', shallow: true, name: 'Ren' }), null);
    assert.equal(cardFromCharacter({ json_data: 'not json' }), null);
    assert.equal(cardFromCharacter(null), null);
});

// --------------------------------------------------------------- hashing ---

test('the hash follows the content, not the object identity', async () => {
    const a = await hashOf({ name: 'Ren', tags: ['a', 'b'] });
    const b = await hashOf({ name: 'Ren', tags: ['a', 'b'] });
    const c = await hashOf({ name: 'Ren', tags: ['a', 'c'] });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[0-9a-f]{64}$/);
});

// --------------------------------------------------------------- restore ---

test('a restore payload puts back old values and removes what was added since', () => {
    const live = { name: 'Ren', description: 'Rewritten.', personality: 'Added later.' };
    const snapshot = { name: 'Ren', description: 'Original.' };

    assert.deepEqual(restorePayload(live, snapshot, UNSET), {
        name: 'Ren',
        description: 'Original.',
        // Without this the deep merge would leave the newer field in place, and
        // "restore" would only ever add.
        personality: UNSET,
    });
});

test('nested additions are removed at their own path', () => {
    const live = { data: { name: 'Ren', extensions: { depth_prompt: {}, tracker: { html: '<div>' } } } };
    const snapshot = { data: { name: 'Ren', extensions: { depth_prompt: {} } } };

    assert.deepEqual(restorePayload(live, snapshot, UNSET), {
        data: { name: 'Ren', extensions: { depth_prompt: {}, tracker: UNSET } },
    });
});

test('arrays are replaced wholesale, so a restore really can shrink one', () => {
    // The host's deepMerge excludes arrays from its recursion, so the snapshot's
    // array wins outright. Nothing extra is needed, and nothing must be added
    // that would defeat it.
    const payload = restorePayload({ tags: ['a', 'b', 'c'] }, { tags: ['a'] }, UNSET);
    assert.deepEqual(payload, { tags: ['a'] });
});

test('restoring into an empty live card adds no sentinels', () => {
    assert.deepEqual(restorePayload({}, { name: 'Ren' }, UNSET), { name: 'Ren' });
});

// ------------------------------------------------------------------ diff ---

test('field differences are named, in a stable order', () => {
    const rows = diffFields(
        { name: 'Ren', description: 'New.', gone: 'x' },
        { name: 'Ren', description: 'Old.', fresh: 'y' },
    );
    assert.deepEqual(rows, [
        { key: 'description', kind: 'changed', from: 'New.', to: 'Old.' },
        { key: 'fresh', kind: 'added', from: undefined, to: 'y' },
        { key: 'gone', kind: 'removed', from: 'x', to: undefined },
    ]);
});

test('a field whose value is deeply equal is not reported as changed', () => {
    assert.deepEqual(diffFields({ a: { b: [1, 2] } }, { a: { b: [1, 2] } }), []);
    assert.equal(diffFields({ a: { b: [1, 2] } }, { a: { b: [2, 1] } }).length, 1);
});

test('lorebook entries are matched by uid, so a rename is one change not two', () => {
    const before = { entries: { 0: { uid: 0, comment: 'Forest', content: 'Trees.' } } };
    const after = { entries: { 0: { uid: 0, comment: 'Deep forest', content: 'Trees.' } } };

    const { added, removed, changed } = diffLorebook(before, after);
    assert.equal(added.length, 0);
    assert.equal(removed.length, 0);
    assert.equal(changed.length, 1);
    assert.deepEqual(changed[0].fields.map(f => f.key), ['comment']);
});

test('entries only on one side are reported as added or removed', () => {
    const { added, removed } = diffLorebook(
        { entries: { 0: { uid: 0, comment: 'Kept' }, 1: { uid: 1, comment: 'Only now' } } },
        { entries: { 0: { uid: 0, comment: 'Kept' }, 2: { uid: 2, comment: 'Only then' } } },
    );
    assert.deepEqual(added.map(e => e.title), ['Only then']);
    assert.deepEqual(removed.map(e => e.title), ['Only now']);
});

test('an entry with no title falls back to its keys', () => {
    assert.equal(entryTitle({ uid: 3, key: ['forest', 'woods'] }), 'forest, woods');
    assert.equal(entryTitle({ uid: 3, comment: 'Forest', key: ['x'] }), 'Forest');
    assert.equal(entryTitle({ uid: 3 }), 'Entry 3');
});

// ----------------------------------------------------------------- prune ---

const rows = (specs) => specs.map(([id, kind, target, ts, size]) => ({ id, kind, target, ts, size }));

test('only the newest few versions of each item are kept', () => {
    const snapshots = rows([
        ['a1', 'character', 'Ren.png', 5, 10],
        ['a2', 'character', 'Ren.png', 4, 10],
        ['a3', 'character', 'Ren.png', 3, 10],
        ['b1', 'lorebook', 'World', 9, 10],
    ]);
    const doomed = prunePlan(snapshots, { keepPerTarget: 2, maxTotalBytes: 1000 });
    assert.deepEqual(doomed, ['a3'], 'the oldest of the over-quota target, and nothing else');
});

test('the byte budget removes the oldest across every item', () => {
    const snapshots = rows([
        ['a1', 'character', 'Ren.png', 5, 60],
        ['a2', 'character', 'Ren.png', 4, 60],
        ['b1', 'lorebook', 'World', 3, 60],
    ]);
    const doomed = prunePlan(snapshots, { keepPerTarget: 99, maxTotalBytes: 100 });
    assert.deepEqual(doomed.sort(), ['a2']);
});

test('the byte budget never deletes the only copy of something', () => {
    // An over-budget history is a nuisance. A target with no history at all is
    // the failure this extension exists to prevent, so the budget loses.
    const snapshots = rows([
        ['a1', 'character', 'Ren.png', 5, 5_000_000],
        ['b1', 'lorebook', 'World', 4, 5_000_000],
        ['c1', 'preset', 'openai/Main', 3, 5_000_000],
    ]);
    const doomed = prunePlan(snapshots, { keepPerTarget: 99, maxTotalBytes: 1 });
    assert.deepEqual(doomed, [], 'every one of these is the newest of its target');
});

test('nothing to prune returns nothing', () => {
    assert.deepEqual(prunePlan([], {}), []);
});
