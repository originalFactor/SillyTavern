import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, jest, test } from '@jest/globals';

function load(file, name) {
    const source = fs.readFileSync(new URL(`../client/lib/extension-runtime/${file}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } });
    const exports = {}; new Function('exports', outputText)(exports);
    return new Function(`return (${exports[name].toString()});`)();
}
const reader = load('resources', 'createExtensionResourceReader');
const observe = load('resources', 'observeExtensionProviderStatus');
const install = load('script', 'installExtensionScript');
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const unchecked = { state: 'unchecked', onlineStatus: 'no_connection', checkedAt: null };
const valid = { state: 'valid', onlineStatus: 'Valid', checkedAt: 123 };

describe('native provider status projection into the extension frame', () => {
    test('accepts only a named empty observation and projects one validated status scalar without keys, URLs or dispatch', async () => {
        const calls = [], controller = new AbortController(); let response = { ...valid, key: 'private', url: 'https://private.test' };
        const read = reader(async (...args) => { calls.push(args); return response; }, controller.signal);
        expect(await read('provider.status', {})).toBe('Valid');
        expect(calls).toEqual([['/provider-status', { signal: controller.signal }]]);
        response = unchecked; expect(await read('provider.status', {})).toBe('no_connection');
        for (const args of [undefined, null, [], { url: 'https://other.test' }, { method: 'POST' }, { check: true }]) await expect(read('provider.status', args)).rejects.toThrow('Invalid');
        await expect(read('provider.status.check', {})).rejects.toThrow('Unsupported');
        expect(calls).toHaveLength(2);
    });
    test('rejects malformed or contradictory native snapshots instead of publishing a connected value', async () => {
        for (const value of [null, {}, { ...valid, state: 'unchecked' }, { ...valid, checkedAt: null }, { ...valid, checkedAt: -1 }, { ...valid, checkedAt: 1.5 }, { ...unchecked, checkedAt: 1 }, { ...unchecked, state: 'bypassed' }, { ...valid, onlineStatus: 'connected' }]) await expect(reader(async () => value)('provider.status', {})).rejects.toThrow('Invalid native provider status');
    });
    test.each(['abort', 'replace'])('discards a delayed status reply on session %s', async mode => {
        const controller = new AbortController(); let finish, current = true;
        const read = reader(() => new Promise(resolve => { finish = resolve; }), controller.signal, { isCurrent: () => current });
        const pending = read('provider.status', {});
        if (mode === 'abort') controller.abort(); else current = false;
        finish(valid); await expect(pending).rejects.toThrow('replaced or aborted');
    });
    test('initializes the getter from native observation and publishes live bindings before changed events, without duplicate events', async () => {
        const published = [], seen = [], requests = [];
        const module = install({}, {
            utils: {}, cleanup: { initialize: async () => {} }, unsupported(name) { throw Error(name); },
            publish: (...args) => published.push(args), events: { ONLINE_STATUS_CHANGED: 'changed' },
            eventSource: { emitAndWait(event, value) { seen.push([event, value, module.online_status, published.at(-1)]); } },
            async request(op, args) { requests.push([op, args]); return op === 'provider.status' ? 'no_connection' : op === 'characters.snapshot' ? { characters: [] } : { bound: false, chat: [], chatMetadata: {} }; },
        });
        expect(() => module.online_status).toThrow('observation is not loaded');
        expect(Object.keys(module)).not.toContain('updateOnlineStatus');
        await module.initialize(); expect(module.online_status).toBe('no_connection'); expect(seen).toEqual([]);
        module.updateOnlineStatus('Valid'); module.updateOnlineStatus('Valid'); module.updateOnlineStatus('no_connection');
        expect(seen).toEqual([
            ['changed', 'Valid', 'Valid', ['/script.js', 'online_status', 'Valid']],
            ['changed', 'no_connection', 'no_connection', ['/script.js', 'online_status', 'no_connection']],
        ]);
        expect(() => module.updateOnlineStatus('Status check bypassed')).toThrow('Invalid'); expect(module.online_status).toBe('no_connection');
        expect(requests.filter(([op]) => op === 'provider.status')).toEqual([['provider.status', {}]]);
    });
    test('polls local observations sequentially, invalidates success on read failure and stops after abort', async () => {
        jest.useFakeTimers();
        try {
            const controller = new AbortController(), published = []; let calls = 0, finish;
            const stop = observe(async op => { expect(op).toBe('provider.status'); calls++; if (calls === 1) return 'Valid'; if (calls === 2) throw Error('backend unavailable'); return await new Promise(resolve => { finish = resolve; }); }, value => published.push(value), controller.signal);
            await tick(); expect(published).toEqual(['Valid']);
            await jest.advanceTimersByTimeAsync(5000); expect(published).toEqual(['Valid', 'no_connection']);
            await jest.advanceTimersByTimeAsync(5000); expect(calls).toBe(3);
            await jest.advanceTimersByTimeAsync(20_000); expect(calls).toBe(3);
            controller.abort(); finish('Valid'); await tick();
            await jest.advanceTimersByTimeAsync(20_000); expect(published).toEqual(['Valid', 'no_connection']); expect(calls).toBe(3);
            stop(); expect(jest.getTimerCount()).toBe(0);
        } finally { jest.useRealTimers(); }
    });
    test('does not read for an already aborted session or publish after explicit disposal', async () => {
        const controller = new AbortController(); controller.abort(); let calls = 0;
        observe(async () => { calls++; }, () => { throw Error('Must not publish'); }, controller.signal)();
        expect(calls).toBe(0);
        let finish;
        const stop = observe(() => new Promise(resolve => { finish = resolve; }), () => { throw Error('Must not publish'); }, new AbortController().signal);
        stop(); finish('Valid'); await tick();
    });
});
