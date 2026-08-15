# Card & Lorebook Time Machine

Earlier versions of your characters, lorebooks and presets, with a comparison view and a confirmed, rollback-first restore.

SillyBunny backs up two things: your chats and `settings.json`. It does not back up character cards, lorebooks, or presets. Those are ordinary files on disk, and an edit to one is permanent the moment it is saved. This extension gives those three a history.

## What it keeps, and what it leaves to the host

| | Backed up by SillyBunny | This extension |
| --- | --- | --- |
| Chats | yes | leaves alone |
| Character card fields | **no** | snapshots when the editor opens and after every edit |
| Character tag assignments | yes, in `settings.json` | also stores them with each character version |
| Lorebooks | **no** | snapshots after every save |
| Presets | **no** | snapshots at startup and when you switch preset |
| Other extensions' settings | yes, in rotating `settings.json` backups | reads those backups and puts one safe extension block back |
| In-chat agent definitions and groups | **no**; they are separate files | leaves alone |

`settings.json` already has rotating backups, so capturing it again would duplicate the server's work. Instead the popup can restore **one** ordinary extension-owned object from one backup. It excludes Time Machine's own index, attachment bookkeeping, host infrastructure, and malformed or prototype-sensitive values. It never calls the host's whole-file restore, which would also undo unrelated changes made since that backup.

Agent definitions and groups are not inside `settings.json`, so the host backup picker cannot recover them. They need to be backed up with the rest of the SillyBunny data directory.

## Using it

The wand menu (🪄) has a **Time Machine** entry. Inside:

- **Snapshot everything now** captures all three kinds even when their automatic toggles are off. Use it before a write that may not emit a host event, such as another extension storing data on a character card.
- The list on the left is everything with a history. Pick one to see its versions.
- **Compare** shows what restoring that version would change: field by field for a card or preset, entry by entry for a lorebook.
- **Restore this version** rereads the item and durably snapshots how it is *right now* before changing it. That rollback is protected during the restore.

Retention lives in **Extensions → Time Machine**: which kinds to capture, and how many versions to keep per item. Identical snapshots are never stored, so an item you have not touched costs nothing however often the triggers fire.

## How a restore works

**Characters** go back through `merge-attributes`, which rewrites the card inside the existing PNG. The file keeps its identity, the image is never re-encoded, and the creation date is untouched. Fields added after the snapshot are removed rather than left behind, and the snapshot's tag assignments are restored too. The avatar filename never changes because chats, tags, and the last-chat record are keyed to it.

**Lorebooks** are written back whole, including the `originalData` the host keeps beside the entries, and saved immediately rather than on the usual delay so the write cannot race the editor.

**Presets** are written straight to the preset route rather than through the manager's save path, which can open dialogs or convert data. The live preset manager is then refreshed with the name the server actually stored.

**Extension settings** are written into settings and confirmed by reading the exact commit back from the server. Extensions commonly read settings only at page load, so reload SillyBunny after restoring a block.

## Where snapshots are stored

Snapshots are JSON files in your SillyBunny user files directory, written through the host's own upload route. They are on the server, not in your browser, so whatever backs up your SillyBunny data directory covers them too, and they survive clearing site data or moving to another browser.

The index, which records which snapshot is which and how large it is, lives in extension settings. Putting the snapshots themselves there would make `settings.json` grow on every capture.

A capture is not reported as successful until its index commit can be read back from the server. Old history is pruned only after the new row is durable. Conflicting tabs in the same browser use the Web Locks API when available; a changed persisted index from another browser or device makes the operation stop and ask for a reload instead of overwriting history.

Two limits keep this bounded, applied after every capture: a number of versions per item (fifteen by default), and a total size budget (50 MB by default). Both can be changed in the extension's settings drawer. The oldest go first, and the newest version of anything is never deleted. An over-budget history is a nuisance, but an item with no history at all is the exact failure this extension exists to prevent.

Snapshots are registered in the attachment map that Data Maid currently scans so it does not offer to delete them. Startup reconciliation repairs that registration from the validated index. This is a working SillyBunny 1.7 integration rather than a documented host API, so back up the whole data directory before using Data Maid after a host upgrade.

## Limits worth knowing

- **Avatar images are not versioned.** Only card fields and tag assignments are stored. Restoring never touches the image, so it cannot recover a deleted or replaced image.
- **A deleted character cannot be brought back.** Restoring writes into an existing card file; if the file is gone there is nothing to write into. The snapshot's fields are still readable in the comparison view.
- **Recreating a deleted lorebook or preset has no automatic undo.** There is no host object to snapshot as the "before" state. The restore confirmation warns about this limitation.
- **Unsafe character shapes are refused.** A top-level `avatars` field, a literal value equal to the host's unset marker, an incompatible non-object-to-object change, or a removal beneath a literal dotted/bracketed key cannot be represented safely by SillyBunny 1.7's merge route. Time Machine stops rather than attempting a lossy or bulk restore.
- **Writes that announce nothing are not caught automatically.** The `merge-attributes` route that other extensions use to store data on a card emits no event. Use **Snapshot everything now** before anything you might want to undo.
- **Preset coverage depends on host events.** Startup, preset switching, and the manual button are the reliable triggers. Advanced preset families can be saved without an event.
- **Lorebook renames have no host event.** Character and preset rename events migrate their history, but renamed lorebook history remains under the old name and can recreate that old book.
- **Cross-device writes cannot be made fully atomic by an extension.** Time Machine checks persisted commits and rereads an item immediately before restoring it. A write after that final check still needs host-side compare-and-swap to prevent; reload before retrying after any conflict.
- **WebCrypto improves deduplication and integrity checks but is not required.** On an insecure origin where `crypto.subtle` is unavailable, snapshots are still saved, but unchanged data may be duplicated and blob hashes cannot be verified.

## Install

Clone this repository and symlink it into `data/<user>/extensions/`, or install it from the extension manager with this repo's URL.

## Development

No build step, no dependencies. Tests use Node's built-in runner:

```sh
npm test
npm run lint
```

`src/core.js` contains pure naming, hashing, diffing, pruning, and restore-payload logic. `src/store.js` owns validated durable storage, `src/api.js` talks to SillyBunny, `src/ui.js` renders the popup, and `index.js` owns lifecycle and event wiring. Tests use only Node's built-in runner.
