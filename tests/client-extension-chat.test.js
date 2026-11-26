import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, jest, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../client/lib/extension-chat.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } });
const exports = {}; new Function('exports', outputText)(exports);
const { createExtensionChatPrinter, createExtensionSendButtons, extensionGenerationState } = exports;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('parent-owned extension send button locks', () => {
    test('disables idempotently and releases only the requesting session', () => {
        const changed = jest.fn(), controls = createExtensionSendButtons(changed);
        const first = new AbortController(), second = new AbortController(), foreign = new AbortController();
        controls.setEnabled(false, first.signal); controls.setEnabled(false, first.signal);
        expect(changed.mock.calls).toEqual([[true]]);
        controls.setEnabled(true, foreign.signal); expect(controls.isDisabled()).toBe(true);
        controls.setEnabled(false, second.signal); controls.setEnabled(true, first.signal);
        expect(controls.isDisabled()).toBe(true);
        second.abort(); expect(controls.isDisabled()).toBe(false);
        expect(changed.mock.calls).toEqual([[true], [true], [true], [false]]);
        first.abort(); foreign.abort(); expect(changed).toHaveBeenCalledTimes(4);
    });
    test('disposes every lock and rejects late requests without reviving controls', () => {
        const changed = jest.fn(), controls = createExtensionSendButtons(changed);
        const first = new AbortController(), second = new AbortController();
        controls.setEnabled(false, first.signal); controls.setEnabled(false, second.signal);
        controls.dispose(); controls.dispose(); first.abort(); second.abort();
        expect(controls.isDisabled()).toBe(false);
        expect(changed.mock.calls).toEqual([[true], [true], [false]]);
        const fresh = new AbortController();
        for (const enabled of [false, true]) expect(() => controls.setEnabled(enabled, fresh.signal)).toThrow('replaced or aborted');
        expect(changed).toHaveBeenCalledTimes(3);
    });
    test('rejects pre-aborted owners and leaves independent native state untouched', () => {
        const changed = jest.fn(), controls = createExtensionSendButtons(changed);
        const owner = new AbortController(); owner.abort();
        for (const enabled of [false, true]) expect(() => controls.setEnabled(enabled, owner.signal)).toThrow('replaced or aborted');
        controls.setEnabled(true, new AbortController().signal); controls.dispose();
        expect(changed).not.toHaveBeenCalled(); expect(controls.isDisabled()).toBe(false);
    });
});

describe('parent-owned printMessages rendering lifecycle', () => {
    test('waits for the exact DOM commit, scrolls once and returns no transcript', async () => {
        const page = { messages: [{ index: 41, mes: 'real stored message' }] };
        const publish = jest.fn(), scroll = jest.fn();
        const read = jest.fn(async signal => { expect(signal.aborted).toBe(false); return page; });
        const printer = createExtensionChatPrinter({ read, publish, scroll });
        let done = false;
        const pending = printer.printMessages().then(value => { done = true; return value; });
        await tick();
        expect(publish.mock.calls[0][0]).toBe(page);
        expect(done).toBe(false); expect(scroll).not.toHaveBeenCalled();
        printer.committed({}); expect(done).toBe(false);
        const ticket = publish.mock.calls[0][1];
        printer.committed(ticket);
        await expect(pending).resolves.toBeUndefined();
        printer.committed(ticket);
        expect(read).toHaveBeenCalledTimes(1); expect(scroll).toHaveBeenCalledTimes(1);
    });
    test('rejects overlapping requests without dispatching a second read', async () => {
        const gate = deferred(), publish = jest.fn(), read = jest.fn(() => gate.promise);
        const printer = createExtensionChatPrinter({ read, publish, scroll() {} });
        const first = printer.printMessages();
        await expect(printer.printMessages()).rejects.toThrow('already in progress');
        gate.resolve({}); await tick(); printer.committed(publish.mock.calls[0][1]);
        await first; expect(read).toHaveBeenCalledTimes(1);
    });
    test.each(['abort', 'replace', 'reload'])('rejects a %s while awaiting I/O and ignores a late response', async kind => {
        const gate = deferred(), publish = jest.fn(), scroll = jest.fn(), signal = new AbortController();
        let readSignal;
        const printer = createExtensionChatPrinter({ read: bound => { readSignal = bound; return gate.promise; }, publish, scroll });
        const pending = printer.printMessages(signal.signal);
        const assertion = expect(pending).rejects.toThrow(/changed|replaced|aborted/);
        if (kind === 'abort') signal.abort(); else if (kind === 'replace') printer.dispose(); else printer.cancel();
        await assertion; expect(readSignal.aborted).toBe(true);
        gate.resolve({ messages: ['stale'] }); await tick();
        expect(publish).not.toHaveBeenCalled(); expect(scroll).not.toHaveBeenCalled();
        if (kind === 'replace') await expect(printer.printMessages()).rejects.toThrow('replaced or aborted');
    });
    test('aborts between publishing and committing without acknowledging or scrolling', async () => {
        const publish = jest.fn(), scroll = jest.fn(), signal = new AbortController();
        const printer = createExtensionChatPrinter({ read: async () => ({}), publish, scroll });
        const pending = printer.printMessages(signal.signal);
        const assertion = expect(pending).rejects.toThrow('replaced or aborted');
        await tick(); signal.abort(); printer.committed(publish.mock.calls[0][1]);
        await assertion; expect(scroll).not.toHaveBeenCalled();
    });
    test('does not replay failed reads and can accept a later explicit render request', async () => {
        const read = jest.fn().mockRejectedValueOnce(Error('read failed')).mockResolvedValueOnce({ messages: [] });
        const publish = jest.fn();
        const printer = createExtensionChatPrinter({ read, publish, scroll() {} });
        await expect(printer.printMessages()).rejects.toThrow('read failed');
        expect(read).toHaveBeenCalledTimes(1); expect(publish).not.toHaveBeenCalled();
        const next = printer.printMessages(); await tick(); printer.committed(publish.mock.calls[0][1]);
        await next; expect(read).toHaveBeenCalledTimes(2);
    });
    test.each(['publish', 'scroll'])('propagates %s failures as unsuccessful renders', async where => {
        let ticket;
        const printer = createExtensionChatPrinter({
            read: async () => ({}),
            publish: (_, value) => { ticket = value; if (where === 'publish') throw Error('publish failed'); },
            scroll: () => { throw Error('scroll failed'); },
        });
        const pending = printer.printMessages();
        const assertion = expect(pending).rejects.toThrow(`${where} failed`);
        await tick(); if (where === 'scroll') printer.committed(ticket);
        await assertion;
    });
    test('rejects pre-aborted sessions without reads and times out an uncommitted render', async () => {
        jest.useFakeTimers();
        try {
            const read = jest.fn(async () => ({})), publish = jest.fn(), signal = new AbortController(); signal.abort();
            const printer = createExtensionChatPrinter({ read, publish, scroll() {} });
            await expect(printer.printMessages(signal.signal)).rejects.toThrow('aborted'); expect(read).not.toHaveBeenCalled();
            const pending = printer.printMessages(); const assertion = expect(pending).rejects.toThrow('timed out');
            await tick(); jest.advanceTimersByTime(25000); await assertion;
            printer.committed(publish.mock.calls[0][1]);
            expect(jest.getTimerCount()).toBe(0);
        } finally { jest.useRealTimers(); }
    });
});


describe('native generation activity projection', () => {
    test('separates submissions, worker activity, drained recovery and group batches', () => {
        expect(extensionGenerationState(false, false, [])).toEqual({ isSendPress: false, isGroupGenerating: false });
        expect(extensionGenerationState(false, true, [])).toEqual({ isSendPress: true, isGroupGenerating: false });
        for (const status of ['accepted', 'preparing', 'streaming', 'awaiting_tools']) {
            expect(extensionGenerationState(false, false, [{ requestId: 'r', seq: 1, status }]).isSendPress).toBe(true);
        }
        for (const status of ['done', 'error', 'failed', 'cancelled', 'unknown']) {
            const record = { requestId: 'r', seq: 4, status, drained: false, acknowledged: false };
            expect(extensionGenerationState(false, false, [record]).isSendPress).toBe(true);
            expect(extensionGenerationState(false, false, [{ ...record, drained: true }]).isSendPress).toBe(false);
        }
        expect(extensionGenerationState(true, true, [])).toEqual({ isSendPress: false, isGroupGenerating: true });
    });
    test('a newer drained observation overrides stale active history, independent of array order', () => {
        const active = { requestId: 'r', seq: 1, status: 'accepted' };
        const done = { requestId: 'r', seq: 5, status: 'unknown', drained: true };
        for (const records of [[active, done], [done, active]]) expect(extensionGenerationState(false, false, records).isSendPress).toBe(false);
        expect(extensionGenerationState(false, false, [done, { ...active, requestId: 'other' }]).isSendPress).toBe(true);
    });
});
