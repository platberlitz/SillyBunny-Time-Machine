/**
 * Everything that can be decided without the app: naming, hashing, diffing,
 * pruning, and building a restore payload.
 *
 * No SillyBunny imports and no DOM, so it runs under `node --test`. Anything
 * that talks to the host lives in api.js; anything that stores bytes lives in
 * store.js.
 */

export const SNAPSHOT_FORMAT = 1;

/** Defaults for how much history is kept. Both are user-editable settings. */
export const DEFAULT_KEEP_PER_TARGET = 15;
export const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A filename fragment the host's upload route will accept.
 *
 * `validateAssetFileName` allows only [A-Za-z0-9_-.], and the files directory is
 * a single flat namespace shared with the user's own attachments, so the prefix
 * is what keeps these identifiable. Two different names can slug to the same
 * text; the index is the source of truth for which snapshot is which, and the
 * timestamp keeps the filenames apart.
 */
export function slug(text, max = 40) {
    const cleaned = String(text ?? '')
        .replace(/\.png$/i, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, max);
    return cleaned || 'unnamed';
}

/**
 * @param {string} kind 'character' or 'lorebook'
 * @param {string} target avatar filename or book name
 * @param {number} ts epoch ms
 * @param {Set<string>|string[]} [taken] filenames already in use
 */
export function snapshotFileName(kind, target, ts, taken = []) {
    const used = taken instanceof Set ? taken : new Set(taken);
    const base = `cardtm_${kind}_${slug(target)}_${ts}`;
    let name = `${base}.json`;
    for (let n = 1; used.has(name); n++) {
        name = `${base}-${n}.json`;
    }
    return name;
}

/**
 * Content hash, used to skip storing a snapshot identical to the last one.
 *
 * WebCrypto rather than a hand-rolled hash: a false "unchanged" silently drops
 * the version the user would later want back, which is the one failure this
 * extension exists to prevent.
 */
export async function hashOf(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The card as it sits in the PNG, without the fields the server adds while
 * reading it.
 *
 * `json_data` is the card's own JSON, so parsing it gives exactly what is on
 * disk — no guessing about which of the character object's keys are the card's
 * and which are the host's. `chat` is dropped: SillyBunny keeps the last opened
 * chat in a sidecar now, so the card's copy is stale by design and restoring it
 * would point the character at whichever chat was open when the snapshot ran.
 */
export function cardFromCharacter(character) {
    if (!isPlainObject(character)) {
        return null;
    }
    let card = null;
    if (typeof character.json_data === 'string') {
        try {
            card = JSON.parse(character.json_data);
        } catch {
            card = null;
        }
    }
    if (!isPlainObject(card)) {
        // Shallow entries have no json_data. Refusing is better than snapshotting
        // a card whose definitions were never loaded.
        return null;
    }
    delete card.chat;
    delete card.json_data;
    delete card.avatar;
    return card;
}

/**
 * The body for POST /api/characters/merge-attributes that turns the live card
 * back into the snapshot.
 *
 * merge-attributes deep-merges, so the snapshot's own values are enough to
 * change what exists — but a key the user has ADDED since the snapshot would
 * survive the merge untouched. Those need the host's unset sentinel, which it
 * removes by path after merging. Arrays are replaced wholesale rather than
 * merged element by element (`isObject` in the host's deepMerge excludes them),
 * so a snapshot with fewer tags really does shrink the list.
 *
 * ponytail: the sentinel is applied with lodash `_.unset(target, 'a.b')`, so a
 * key containing a literal dot resolves to the wrong path and is left in place.
 * Card fields never contain one; a third-party `extensions` block could. Upgrade
 * path is to report those keys as unrestorable rather than to silently miss
 * them.
 */
export function restorePayload(live, snapshot, unsetValue) {
    const payload = structuredClone(snapshot ?? {});
    markRemoved(payload, live, snapshot, unsetValue);
    return payload;
}

function markRemoved(payload, live, snapshot, unsetValue) {
    if (!isPlainObject(live) || !isPlainObject(payload)) {
        return;
    }
    for (const key of Object.keys(live)) {
        if (!isPlainObject(snapshot) || !Object.prototype.hasOwnProperty.call(snapshot, key)) {
            payload[key] = unsetValue;
            continue;
        }
        if (isPlainObject(live[key]) && isPlainObject(snapshot[key])) {
            markRemoved(payload[key], live[key], snapshot[key], unsetValue);
        }
    }
}

/** Stable text for comparing a value against another. */
function compareAs(value) {
    return value === undefined ? undefined : JSON.stringify(value);
}

/**
 * Field-level differences between two plain objects.
 *
 * Field-level rather than line-level on purpose: a card is a handful of named
 * fields, and "the description changed" answers the question a line diff makes
 * you reconstruct. Nested objects and arrays are compared whole.
 *
 * @returns {{key: string, kind: 'added'|'removed'|'changed', from: any, to: any}[]}
 */
export function diffFields(before, after) {
    const a = isPlainObject(before) ? before : {};
    const b = isPlainObject(after) ? after : {};
    const rows = [];
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        const from = compareAs(a[key]);
        const to = compareAs(b[key]);
        if (from === to) {
            continue;
        }
        const kind = from === undefined ? 'added' : to === undefined ? 'removed' : 'changed';
        rows.push({ key, kind, from: a[key], to: b[key] });
    }
    return rows;
}

/**
 * Entry-level differences between two world info books, matched by uid.
 *
 * The host keys `entries` by uid and reuses those keys, so uid is the only
 * stable identity an entry has — matching on title would report a renamed entry
 * as one deleted and one added.
 */
export function diffLorebook(before, after) {
    const a = isPlainObject(before?.entries) ? before.entries : {};
    const b = isPlainObject(after?.entries) ? after.entries : {};
    const added = [];
    const removed = [];
    const changed = [];

    for (const uid of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        const from = a[uid];
        const to = b[uid];
        if (from === undefined) {
            added.push({ uid, entry: to, title: entryTitle(to) });
        } else if (to === undefined) {
            removed.push({ uid, entry: from, title: entryTitle(from) });
        } else {
            const fields = diffFields(from, to);
            if (fields.length > 0) {
                changed.push({ uid, title: entryTitle(to) || entryTitle(from), fields });
            }
        }
    }

    return { added, removed, changed };
}

export function entryTitle(entry) {
    if (!isPlainObject(entry)) {
        return '';
    }
    const named = [entry.comment, entry.name].find(value => typeof value === 'string' && value.trim() !== '');
    if (named) {
        return named.trim();
    }
    const keys = Array.isArray(entry.key) ? entry.key.filter(k => typeof k === 'string') : [];
    return keys.length > 0 ? keys.join(', ') : `Entry ${entry.uid ?? ''}`.trim();
}

/**
 * Which snapshots to delete, oldest first.
 *
 * Two limits, because either alone fails: a per-target count lets one enormous
 * lorebook fill the disk on its own, and a byte cap alone lets a busy character
 * push every other target's history out.
 *
 * The newest snapshot of each target is never deleted. If the byte cap cannot
 * be met without it, the cap loses — an over-budget history is a nuisance, and
 * a target with no history at all is the failure this extension exists to
 * prevent.
 */
export function prunePlan(snapshots, { keepPerTarget = DEFAULT_KEEP_PER_TARGET, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES } = {}) {
    const doomed = new Set();
    const byTarget = new Map();

    for (const snapshot of snapshots) {
        const key = `${snapshot.kind}:${snapshot.target}`;
        if (!byTarget.has(key)) {
            byTarget.set(key, []);
        }
        byTarget.get(key).push(snapshot);
    }

    const newest = new Set();
    for (const list of byTarget.values()) {
        list.sort((a, b) => b.ts - a.ts);
        newest.add(list[0].id);
        for (const snapshot of list.slice(keepPerTarget)) {
            doomed.add(snapshot.id);
        }
    }

    const survivors = snapshots
        .filter(snapshot => !doomed.has(snapshot.id))
        .sort((a, b) => b.ts - a.ts);

    let total = 0;
    for (const snapshot of survivors) {
        total += snapshot.size ?? 0;
        if (total > maxTotalBytes && !newest.has(snapshot.id)) {
            doomed.add(snapshot.id);
        }
    }

    return [...doomed];
}

/** Newest first, which is the only order the timeline is ever shown in. */
export function sortSnapshots(snapshots) {
    return [...snapshots].sort((a, b) => b.ts - a.ts);
}

export function formatWhen(ts, now = Date.now()) {
    const seconds = Math.max(0, Math.round((now - ts) / 1000));
    if (seconds < 60) {
        return 'just now';
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    }
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes)) {
        return '';
    }
    if (bytes < 1024) {
        return `${bytes} bytes`;
    }
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
