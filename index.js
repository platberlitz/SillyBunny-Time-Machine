/**
 * Card & Lorebook Time Machine.
 *
 * Automatic snapshots of the things SillyBunny does not back up — characters,
 * lorebooks and presets — with a comparison view and one-click restore.
 */
import { captureCharacter, captureLorebook, capturePresets } from './src/api.js';
import { closeTimeMachine, openTimeMachine, renderDrawer } from './src/ui.js';

const MENU_ITEM_ID = 'sbctm-menu-item';
const DRAWER_ID = 'sbctm-settings-drawer';

const subscriptions = [];
let active = false;

function ctx() {
    return globalThis.SillyTavern.getContext();
}

function subscribe(eventType, handler) {
    if (!eventType) {
        return;
    }
    ctx().eventSource.on(eventType, handler);
    subscriptions.push({ eventType, handler });
}

/** A capture must never take the app down with it. */
function guard(promise) {
    void Promise.resolve(promise).catch((error) => {
        console.error('[Time Machine] snapshot failed', error);
    });
}

function onOpen(event) {
    event.preventDefault();
    event.stopPropagation();
    void openTimeMachine().catch((error) => {
        console.error('[Time Machine] failed to open:', error);
        globalThis.toastr?.error('Could not open the Time Machine.');
    });
}

function ensureMenuItem() {
    const host = document.getElementById('extensionsMenu');
    if (!host) {
        return;
    }
    let item = document.getElementById(MENU_ITEM_ID);
    if (!item) {
        // Wand entries must be divs: the host styles `#extensionsMenu > div`.
        item = document.createElement('div');
        item.id = MENU_ITEM_ID;
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.title = 'Earlier versions of your characters, lorebooks and presets';
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        const icon = document.createElement('span');
        icon.className = 'fa-solid fa-clock-rotate-left extensionsMenuExtensionButton';
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = 'Time Machine';
        item.append(icon, label);
        item.addEventListener('click', onOpen);
        item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                onOpen(event);
            }
        });
    }
    if (item.parentElement !== host) {
        host.append(item);
    }
}

function ensureDrawer() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) {
        return;
    }
    let drawer = document.getElementById(DRAWER_ID);
    if (!drawer) {
        drawer = document.createElement('div');
        drawer.id = DRAWER_ID;
        drawer.className = 'inline-drawer';

        const toggle = document.createElement('div');
        toggle.className = 'inline-drawer-toggle inline-drawer-header';
        const title = document.createElement('b');
        title.textContent = 'Time Machine';
        const chevron = document.createElement('div');
        chevron.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
        toggle.append(title, chevron);

        const content = document.createElement('div');
        content.className = 'inline-drawer-content';
        drawer.append(toggle, content);
        host.append(drawer);
    }
    renderDrawer(drawer.querySelector('.inline-drawer-content'));
}

function init() {
    if (active) {
        return;
    }
    active = true;
    const events = ctx().eventTypes;

    subscribe(events.APP_READY, () => {
        ensureMenuItem();
        ensureDrawer();
        guard(capturePresets());
    });

    // Opening the editor is the baseline: it is the last moment the card is
    // certainly as the user left it. Identical snapshots are discarded, so
    // capturing here costs nothing when nothing is changed.
    subscribe(events.CHARACTER_EDITOR_OPENED, (chid) => {
        const avatar = ctx().characters?.[chid]?.avatar;
        if (avatar) {
            guard(captureCharacter(avatar));
        }
    });

    subscribe(events.CHARACTER_EDITED, (event) => {
        const avatar = event?.detail?.character?.avatar ?? ctx().characters?.[event?.detail?.id]?.avatar;
        if (avatar) {
            guard(captureCharacter(avatar));
        }
    });

    // WORLDINFO_UPDATED fires from inside the host's own save, after the write
    // succeeded, and carries the book — so this is the complete set of lorebook
    // saves with no polling and no second read.
    subscribe(events.WORLDINFO_UPDATED, (name, data) => {
        if (name) {
            guard(captureLorebook(name, data));
        }
    });

    // Presets have no save event at all. Switching preset is the nearest thing:
    // whatever was done to the previous one has been written by then.
    subscribe(events.PRESET_CHANGED, () => guard(capturePresets()));

    ensureMenuItem();
    ensureDrawer();
}

async function deactivate() {
    if (!active) {
        return;
    }
    active = false;
    const { eventSource } = ctx();
    while (subscriptions.length) {
        const { eventType, handler } = subscriptions.pop();
        eventSource.removeListener(eventType, handler);
    }
    document.getElementById(MENU_ITEM_ID)?.remove();
    document.getElementById(DRAWER_ID)?.remove();
    await closeTimeMachine();
}

export function activate() {
    init();
}

export function enable() {
    init();
}

export function disable() {
    return deactivate();
}
