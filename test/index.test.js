import test from 'node:test';
import assert from 'node:assert/strict';

import { activate, disable } from '../index.js';

test('activation fails closed when required SillyBunny capabilities are absent', async () => {
    const errors = [];
    const originalError = console.error;
    console.error = () => {};
    globalThis.SillyTavern = { getContext: () => ({}) };
    globalThis.toastr = { error: message => errors.push(message) };

    try {
        assert.throws(() => activate(), /Unsupported SillyBunny context/);
        assert.equal(errors.length, 1);
        await disable();
    } finally {
        console.error = originalError;
        delete globalThis.SillyTavern;
        delete globalThis.toastr;
    }
});
