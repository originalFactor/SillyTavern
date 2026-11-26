import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, test } from '@jest/globals';
function load(file) {
    const source = fs.readFileSync(new URL(`../client/lib/${file}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } });
    const exports = {}; new Function('exports', outputText)(exports); return exports;
}
const { installExtensionScript } = load('extension-runtime/script');
const { createExtensionPromptCollector } = load('extension-prompts');
const entry = { value: 'Injected {{char}}', position: 1, depth: 0, scan: true, role: 0 };
const frame = enabled => installExtensionScript({}, { promptInjectionEnabled: enabled, utils: {}, unsupported(name) { throw Error(name); } });
describe('extension prompt registry and native capture', () => {
    test('keeps one mutable source registry, source coercions/defaults and direct deletion', async () => {
        const module = frame(true), registry = module.extension_prompts;
        expect(module.setExtensionPrompt('a', 123, '1', '5', 1, null)).toBeUndefined();
        expect(registry.a).toEqual({ value: '123', position: 1, depth: 5, scan: true, role: 0, filter: null });
        registry.a.value = 'Edited'; registry.b = { ...entry };
        delete registry.a;
        expect(module.extension_prompts).toBe(registry);
        expect(await module.collectExtensionPrompts()).toEqual({ b: entry });
        expect(Object.keys(module)).not.toContain('collectExtensionPrompts');
        expect(() => module.setExtensionPrompt('__proto__', 'x', 1, 0)).toThrow('key');
        expect(() => Object.setPrototypeOf(registry, {})).toThrow('prototypes');
    });
    test('resolves async and sync filters once in sorted key order and snapshots before awaits', async () => {
        const module = frame(true), calls = [];
        module.setExtensionPrompt('b', 'keep', 1, 0, false, 1, async () => { calls.push('b'); return true; });
        module.setExtensionPrompt('a', 'omit', 1, 0, false, 0, () => { calls.push('a'); module.extension_prompts.b.value = 'later'; return false; });
        expect(await module.collectExtensionPrompts()).toEqual({ b: { value: 'keep', position: 1, depth: 0, scan: false, role: 1 } });
        expect(calls).toEqual(['a', 'b']);
        module.setExtensionPrompt('error', 'x', 1, 0, false, 0, () => { throw Error('predicate failed'); });
        await expect(module.collectExtensionPrompts()).rejects.toThrow('predicate failed');
    });
    test('rejects unsupported hosts and malformed, nested-mutated or oversized entries', async () => {
        const unbound = frame(false);
        expect(Object.keys(unbound.extension_prompts)).toEqual([]);
        expect(() => unbound.setExtensionPrompt('a', 'x', 1, 0)).toThrow('not bound');
        expect(() => { unbound.extension_prompts.a = entry; }).toThrow('not bound');
        const module = frame(true);
        for (const changed of [{ depth: -1 }, { depth: 10001 }, { role: 9 }, { position: 3 }, { filter: 'code' }, { value: 'x'.repeat(65537) }]) expect(() => { module.extension_prompts.a = { ...entry, ...changed }; }).toThrow('Invalid');
        module.extension_prompts.a = { ...entry }; module.extension_prompts.a.depth = -1;
        await expect(module.collectExtensionPrompts()).rejects.toThrow('Invalid');
        delete module.extension_prompts.a;
        for (let i = 0; i < 128; i++) module.extension_prompts[String(i)] = { ...entry };
        expect(() => module.setExtensionPrompt('overflow', 'x', 1, 0)).toThrow('key');
        module.extension_prompts['0'].value = 'x'.repeat(65536);
        for (let i = 1; i < 20; i++) module.extension_prompts[String(i)].value = 'x'.repeat(65536);
        await expect(module.collectExtensionPrompts()).rejects.toThrow('1 MiB');
    });
    test('parent collector rejects duplicate keys and aborts capture when a source closes, without retry', async () => {
        const collector = createExtensionPromptCollector(), a = new AbortController(), b = new AbortController();
        let calls = 0;
        collector.register(async () => { calls++; return { a: entry }; }, a.signal);
        expect(await collector.collect()).toEqual({ a: entry });
        collector.register(async () => ({ a: entry }), b.signal);
        await expect(collector.collect()).rejects.toThrow('same key');
        a.abort(); expect(await collector.collect()).toEqual({ a: entry }); b.abort();
        expect(await collector.collect()).toEqual({}); expect(calls).toBe(2);
        let finish; const c = new AbortController();
        collector.register(() => new Promise(resolve => { finish = resolve; }), c.signal);
        const pending = collector.collect(); await expect(collector.collect()).rejects.toThrow('in progress');
        c.abort(); finish({ c: entry }); await expect(pending).rejects.toThrow('changed');
        collector.dispose(); await expect(collector.collect()).rejects.toThrow('unavailable');
    });
});
