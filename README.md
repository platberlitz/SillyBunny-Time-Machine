# Card & Lorebook Time Machine

Earlier versions of your characters, lorebooks and presets, with a comparison view and one-click restore.

SillyBunny backs up two things: your chats, and `settings.json`. It does not back up character cards, lorebooks or presets. Those are ordinary files on disk, and an edit to one is permanent the moment it is saved — there is no undo, no history, and nothing to compare against. This extension gives those three a history.

## What it keeps, and what it leaves to the host

| | Backed up by SillyBunny | This extension |
| --- | --- | --- |
| Chats | yes | leaves alone |
| Characters | **no** | snapshots when the editor opens and after every edit |
| Lorebooks | **no** | snapshots after every save |
| Presets | **no** | snapshots at startup and when you switch preset |
| Agents, tags, other extensions' settings | yes — `settings.json`, on a ten-minute timer, fifty copies kept | reads the host's backups and puts one block back |

That last row is the point of the table. `settings.json` already has a rotating, deduplicated backup, so capturing it again would be work the server has already done. Instead the popup reads those backups and offers to restore **one** extension's settings out of one of them — which is what you want after an "Update All" rebuilds every agent from its template and takes your customisations with it. It never calls the host's own restore, which replaces the whole file and would undo everything else you changed since.

## Using it

The wand menu (🪄) has a **Time Machine** entry. Inside:

- **Snapshot everything now** — for the times the automatic triggers cannot help. Some writes announce themselves and some do not: another extension storing data on a character card goes through a route that emits no event at all.
- The list on the left is everything with a history. Pick one to see its versions.
- **Compare** shows what restoring that version would change: field by field for a card or preset, entry by entry for a lorebook.
- **Restore this version** takes a snapshot of how things are *right now* first, so restoring is itself undoable.

Retention lives in **Extensions → Time Machine**: which kinds to capture, and how many versions to keep per item. Identical snapshots are never stored, so an item you have not touched costs nothing however often the triggers fire.

## How a restore works

**Characters** go back through `merge-attributes`, which rewrites the card inside the existing PNG. The file keeps its identity, the image is never re-encoded, and the creation date is untouched. Fields you added after the snapshot are removed rather than left behind, so restoring really does return the card to that version instead of merely adding old values back on top. The avatar filename never changes — chats, tags and the last-chat record are all keyed to it, and a character that comes back under a new filename loses all three.

**Lorebooks** are written back whole, including the `originalData` the host keeps beside the entries, and saved immediately rather than on the usual delay so the write cannot race the editor.

**Presets** are written straight to the preset route rather than through the preset manager, which would pop a system-prompt dialog for instruct presets and rewrite NovelAI presets through a converter on the way past.

**Extension settings** are written into settings and saved — but extensions read their settings once when the page loads, so reload SillyBunny for a restored block to take effect. The confirmation says so.

## Where snapshots are stored

Snapshots are JSON files in your SillyBunny user files directory, written through the host's own upload route. They are on the server, not in your browser, so whatever backs up your SillyBunny data directory covers them too, and they survive clearing site data or moving to another browser.

The index — which snapshot is which, and how big — lives in extension settings, and only the index. Putting the snapshots themselves there would grow `settings.json`, which is rewritten on nearly every action and copied into the backup folder on a timer.

Two limits keep this bounded, applied after every capture: a number of versions per item (fifteen by default), and a total size budget (50 MB). The oldest go first, and the newest version of anything is never deleted — an over-budget history is a nuisance, but an item with no history at all is the exact failure this extension exists to prevent.

**Snapshots are registered with SillyBunny's Data Maid so it does not offer to delete them**, under a key that keeps them out of your Data Bank list. They are this extension's bookkeeping, not files you attached to anything.

## Limits worth knowing

- **Avatar images are not versioned.** Only the card's fields are stored. Restoring never touches the image, so the image cannot be lost by a restore either — but it also cannot be recovered by one.
- **A deleted character cannot be brought back.** Restoring writes into an existing card file; if the file is gone there is nothing to write into. The snapshot's fields are still readable in the comparison view.
- **Writes that announce nothing are not caught automatically.** `merge-attributes` — the route other extensions use to store data on a card — emits no event. Use **Snapshot everything now** before anything you might want to undo.
- **Presets have no save event of any kind.** Startup, switching preset, and the manual button are the triggers.

## Install

Clone this repository and symlink it into `data/<user>/extensions/`, or install it from the extension manager with this repo's URL.

## Development

No build step, no dependencies. Tests use Node's built-in runner:

```
npm test
npm run lint
```

`src/core.js` is pure — naming, hashing, diffing, pruning and building a restore payload — and is where the tests are. `src/store.js` is storage, `src/api.js` is everything that talks to SillyBunny, and `src/ui.js` is the popup.
