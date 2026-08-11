/**
 * Everything that talks to SillyBunny: taking a snapshot, reading the current
 * state to compare against, and putting a version back.
 *
 * The division of labour with the host is deliberate.
 *
 * Characters, lorebooks and presets are separate files on disk and nothing in
 * SillyBunny backs any of them up — only chats and settings.json have backups.
 * So this extension captures those three itself.
 *
 * Agents, tags and every other extension's settings DO live in settings.json,
 * which the server copies into the backup folder whenever it changes, at most
 * once every ten minutes, keeping fifty deduplicated copies. Capturing those
 * again would be work the host has already done, so for those this reads the
 * host's own backups and puts one piece back out of them.
 */
import { cardFromCharacter, restorePayload } from './core.js';
import { getSettings, save } from './store.js';

function ctx() {
    return globalThis.SillyTavern.getContext();
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

// ---------------------------------------------------------------- capture ---

/**
 * @param {string} avatar the character's avatar filename, which is its identity
 *   everywhere: chats, tags, and the last-chat sidecar are all keyed to it.
 */
export async function captureCharacter(avatar) {
    if (!getSettings().captureCharacters) {
        return null;
    }
    const live = ctx().characters ?? [];
    const index = live.findIndex(character => character?.avatar === avatar);
    if (index === -1) {
        return null;
    }
    // A shallow entry has no definitions at all, so snapshotting one would store
    // an empty description as though the user had cleared it.
    await ctx().unshallowCharacter(index);
    const card = cardFromCharacter(live[index]);
    if (!card) {
        return null;
    }

    return save({
        kind: 'character',
        target: avatar,
        label: live[index].name || avatar,
        data: card,
        // Tags are not in the card. They live in settings.json keyed by avatar
        // and are deleted outright when a character is, so a restored card
        // without them comes back untagged.
        extra: { tags: structuredClone(ctx().tagMap?.[avatar] ?? []) },
    });
}

export async function captureLorebook(name, data) {
    if (!getSettings().captureLorebooks) {
        return null;
    }
    // The whole book object, not a rebuild from `entries`: it also carries
    // originalData, which the host uses to write entries back in their source
    // form. Reconstructing the book would quietly drop it.
    const book = data ?? await ctx().loadWorldInfo(name);
    if (!book) {
        return null;
    }
    return save({ kind: 'lorebook', target: name, label: name, data: structuredClone(book) });
}

/**
 * Every named preset, from every API family that has them.
 *
 * One call: /api/settings/get assembles all of them from their directories, so
 * this is the whole preset collection in a single round trip rather than one per
 * preset. The four completion families return file CONTENTS as strings beside a
 * parallel array of names; instruct, context, sysprompt and reasoning return
 * already-parsed objects that carry their own name.
 *
 * @returns {Promise<{apiId: string, name: string, preset: object}[]>}
 */
export async function readAllPresets() {
    const response = await post('/api/settings/get', {});
    const settings = await response.json();
    const presets = [];

    const paired = [
        ['openai', 'openai_setting_names', 'openai_settings'],
        ['textgenerationwebui', 'textgenerationwebui_preset_names', 'textgenerationwebui_presets'],
        ['kobold', 'koboldai_setting_names', 'koboldai_settings'],
        ['novel', 'novelai_setting_names', 'novelai_settings'],
    ];
    for (const [apiId, namesKey, bodiesKey] of paired) {
        const names = settings?.[namesKey];
        const bodies = settings?.[bodiesKey];
        if (!Array.isArray(names) || !Array.isArray(bodies)) {
            continue;
        }
        names.forEach((name, index) => {
            const body = bodies[index];
            try {
                const preset = typeof body === 'string' ? JSON.parse(body) : body;
                if (preset && typeof preset === 'object') {
                    presets.push({ apiId, name, preset });
                }
            } catch {
                // A preset file that is not valid JSON is the host's problem to
                // report; skipping it is better than failing the whole sweep.
            }
        });
    }

    for (const apiId of ['instruct', 'context', 'sysprompt', 'reasoning']) {
        for (const preset of settings?.[apiId] ?? []) {
            if (preset && typeof preset === 'object' && typeof preset.name === 'string') {
                presets.push({ apiId, name: preset.name, preset });
            }
        }
    }

    return presets;
}

/**
 * Snapshots every preset whose contents have changed.
 *
 * Presets have no save event of any kind — PRESET_CHANGED fires when one is
 * selected, not when one is saved, and the instruct/context/sysprompt families
 * emit nothing at all. So this runs on the coarse triggers instead (startup,
 * preset switch, and the manual button) and leans on hashing: a sweep where
 * nothing changed stores nothing and costs one local request.
 */
export async function capturePresets() {
    if (!getSettings().capturePresets) {
        return 0;
    }
    let taken = 0;
    for (const { apiId, name, preset } of await readAllPresets()) {
        const row = await save({
            kind: 'preset',
            target: `${apiId}/${name}`,
            label: `${name} (${apiId})`,
            data: preset,
        });
        if (row) {
            taken++;
        }
    }
    return taken;
}

/**
 * Snapshots everything now.
 *
 * The events cover ordinary editing, but not every write announces itself —
 * /api/characters/merge-attributes emits nothing at all, which is how other
 * extensions store their own data on a card. This is the answer to that, and to
 * "I am about to do something I might regret".
 *
 * ponytail: no periodic sweep. It would mean reading every character and book on
 * a timer to hash them, on a box that is already sharing one core. Add one if a
 * silent write turns out to matter more than the cost.
 */
export async function captureEverything(onProgress = () => {}) {
    const context = ctx();
    let taken = 0;

    await context.getCharacters();
    const characters = [...(context.characters ?? [])];
    for (const [done, character] of characters.entries()) {
        onProgress(`Characters: ${done + 1} of ${characters.length}`);
        if (await captureCharacter(character.avatar)) {
            taken++;
        }
    }

    const names = context.getWorldInfoNames?.() ?? [];
    for (const [done, name] of names.entries()) {
        onProgress(`Lorebooks: ${done + 1} of ${names.length}`);
        if (await captureLorebook(name)) {
            taken++;
        }
    }

    onProgress('Presets...');
    taken += await capturePresets();

    return taken;
}

// ------------------------------------------------------------- live state ---

/** The card as it is right now, to compare a snapshot against. */
export async function liveCharacterCard(avatar) {
    const live = ctx().characters ?? [];
    const index = live.findIndex(character => character?.avatar === avatar);
    if (index === -1) {
        return null;
    }
    await ctx().unshallowCharacter(index);
    return cardFromCharacter(live[index]);
}

export async function liveLorebook(name) {
    try {
        return await ctx().loadWorldInfo(name);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------- restore ---

/**
 * Writes a snapshot's card back over the live one.
 *
 * merge-attributes preserves the file's identity and skips the write entirely
 * when nothing would change, and it never touches the image. Importing the card
 * instead would reset its creation date and re-encode the PNG through Jimp on
 * every restore, losing a little image quality each time.
 *
 * @param {string} avatar
 * @param {object} card the snapshot's card
 * @param {object} live the card as it is now, for working out what to remove
 * @param {string[]|null} tags
 */
export async function restoreCharacter(avatar, card, live, tags) {
    const payload = restorePayload(live ?? {}, card, ctx().constants.unset);
    await post('/api/characters/merge-attributes', { avatar, ...payload });

    if (Array.isArray(tags) && ctx().tagMap) {
        ctx().tagMap[avatar] = structuredClone(tags);
        ctx().saveSettingsDebounced();
    }
    await ctx().getCharacters();
}

export async function restoreLorebook(name, book) {
    // `immediately`: the ordinary path debounces by several seconds, which races
    // the editor if the book being restored is the one on screen.
    await ctx().saveWorldInfo(name, book, true);
    ctx().updateWorldInfoList?.();
    ctx().reloadWorldInfoEditor?.(name);
}

/**
 * Writes one preset back.
 *
 * The raw route rather than PresetManager.savePreset: that opens a system-prompt
 * dialog for instruct presets and rewrites novel presets through a converter,
 * neither of which belongs in "put this back exactly as it was". Saving also
 * retires the tombstone that stops a deleted bundled preset from being seeded
 * again, so restoring one the user deliberately deleted really does bring it
 * back for good.
 */
export async function restorePreset(apiId, name, preset) {
    const response = await post('/api/presets/save', { preset, name, apiId });
    const body = await response.json().catch(() => ({}));
    // The server sanitises the name, so what it stored may not be what was sent.
    return body?.name ?? name;
}

/**
 * Writes one extension's settings block back from a host settings backup.
 *
 * This is the path for the damage that prompted the extension: an "Update All"
 * that rebuilt every agent from its bundled template and kept six fields.
 * Extensions read their settings once at startup, so this cannot take effect
 * until the page is reloaded — the caller has to say so.
 */
export function restoreExtensionBlock(key, value) {
    ctx().extensionSettings[key] = structuredClone(value);
    ctx().saveSettingsDebounced();
}

// -------------------------------------------------- the host's own backups ---

/** @returns {Promise<{name: string, date: number, size: number}[]>} newest first */
export async function listHostSnapshots() {
    const response = await post('/api/settings/get-snapshots', {});
    const rows = await response.json();
    return Array.isArray(rows) ? rows.sort((a, b) => b.date - a.date) : [];
}

/**
 * One past settings.json, parsed.
 *
 * Read only. /api/settings/restore-snapshot exists but replaces the entire file,
 * which would undo everything else the user has changed since — the opposite of
 * what this extension is for.
 */
export async function loadHostSnapshot(name) {
    const response = await post('/api/settings/load-snapshot', { name });
    return response.json();
}

/** The extension settings blocks a backup carries, as names a user recognises. */
export function hostSnapshotParts(settings) {
    return Object.keys(settings?.extension_settings ?? {})
        .sort()
        .map(key => ({ kind: 'extension', key, label: key }));
}
