import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, test } from '@jest/globals';

function load(file) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } });
    const exports = {}; new Function('exports', outputText)(exports); return exports;
}
const compiled = load('../client/lib/extension-runtime/regex.ts').installExtensionRegex;
const install = new Function(`return (${compiled.toString()});`)();
const { installExtensionRuntime } = load('../client/lib/extension-runtime/core.ts');
const { createExtensionResourceReader } = load('../client/lib/extension-runtime/resources.ts');
const unsupported = name => { throw Error(`Unsupported: ${name}`); };
const { utils } = installExtensionRuntime({}, { unsupported }, {}, 'en-US');
const rule = overrides => ({ id: 'rule', scriptName: 'Example', findRegex: '/x/g', replaceString: 'y', placement: [1], trimStrings: [], substituteRegex: 0, ...overrides });
const snapshot = overrides => ({ enabled: true, scripts: [rule()], characterAllowed: ['ada.png'], presetAllowed: { openai: ['Selected'] }, apiId: 'openai', presetName: 'Selected', presetScripts: [rule({ findRegex: '/y/g', replaceString: 'z' })], ...overrides });
function frame(value = snapshot(), context) {
    const calls = [];
    const module = install({}, { unsupported, regexFromString: utils.regexFromString, getContext: () => context, request: async (...args) => { calls.push(args); return structuredClone(value); } })['/scripts/extensions/regex/engine.js'];
    return { module, calls };
}
function fixture() {
    const document = { revision: 'regex-1', settings: { enabled: true, scripts: [rule({ opaque: { api_key: 'hidden' } })], characterAllowed: ['ada.png'], presetAllowed: { openai: ['Selected'] } } };
    const settings = { typed: { main_api: 'openai', oai_settings: { api_key: 'hidden' } } };
    const active = { kind: 'chat-completion', name: 'Selected', revision: 'active-1', preset: { custom_url: 'https://hidden.invalid', extensions: { regex_scripts: [rule({ findRegex: '/y/', replaceString: 'z', secret: 'hidden' })], other: 'hidden' } } };
    const calls = [];
    const api = async (path, init) => {
        calls.push([path, init]);
        if (path === '/settings') return structuredClone(settings);
        if (path === '/regex-settings') return structuredClone(document);
        if (path === '/preset-settings/chat-completion') return structuredClone(active);
        throw Error(`Unexpected API: ${path}`);
    };
    return { document, settings, active, calls, api };
}

describe('upstream regex settings-frame runtime', () => {
    test('serializes without helpers and exposes upstream constants and per-instance LRU caches', () => {
        const { module: m } = frame();
        expect(m.SCRIPT_TYPES).toEqual({ GLOBAL: 0, PRESET: 2, SCOPED: 1 });
        expect(m.SCRIPT_TYPE_UNKNOWN).toBe(-1);
        expect(m.regex_placement).toEqual({ MD_DISPLAY: 0, USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 });
        expect(m.substitute_find_regex).toEqual({ NONE: 0, RAW: 1, ESCAPED: 2 });
        const provider = new m.RegexProvider();
        const global = provider.get('/x/g'); global.test('xx'); expect(global.lastIndex).toBe(1);
        expect(provider.get('/x/g')).toBe(global); expect(global.lastIndex).toBe(0);
        expect(provider.get('/[/g')).toBeNull();
        const second = provider.get('second');
        for (let i = 0; i < 998; i++) provider.get(`item${i}`);
        expect(provider.get('/x/g')).toBe(global); // Promote to newest before eviction.
        provider.get('overflow');
        expect(provider.get('/x/g')).toBe(global); expect(provider.get('second')).not.toBe(second);
        expect(m.RegexProvider.instance.get('/x/g')).not.toBe(global);
        provider.clear(); expect(provider.get('/x/g')).not.toBe(global);
        expect(frame().module.RegexProvider.instance).not.toBe(m.RegexProvider.instance);
    });
    test('preserves upstream regex-string parsing including invalid flags and bare patterns', () => {
        for (const [input, source, flags] of [['/a/gi', 'a', 'gi'], ['abc', 'abc', ''], ['/a/y', '\\/a\\/y', ''], ['/a/gg', '\\/a\\/gg', '']]) {
            const regex = utils.regexFromString(input); expect(regex.source).toBe(source); expect(regex.flags).toBe(flags);
        }
        for (const input of ['', '/[/g', '/x/x', null, 5]) expect(utils.regexFromString(input)).toBeUndefined();
    });
    test('reads detached global then preset scripts, honors scope grants and does not invent a character', async () => {
        const { module: m, calls } = frame();
        expect(() => m.getRegexScripts()).toThrow('not loaded');
        expect(Object.keys(m)).not.toContain('initialize'); await m.initialize();
        expect(calls).toEqual([['regex.snapshot', {}]]);
        expect(m.getCurrentPresetAPI()).toBe('openai'); expect(m.getCurrentPresetName()).toBe('Selected');
        expect(m.getRegexScripts().map(r => r.replaceString)).toEqual(['y', 'z']);
        expect(m.getScriptsByType(m.SCRIPT_TYPES.SCOPED)).toEqual([]);
        expect(m.getScriptsByType(-1)).toEqual([]); expect(m.getScriptsByType(100)).toEqual([]);
        expect(m.isScopedScriptsAllowed({ avatar: 'ada.png' })).toBe(true); expect(m.isScopedScriptsAllowed()).toBe(false);
        expect(m.isPresetScriptsAllowed('openai', 'Selected')).toBe(true); expect(m.isPresetScriptsAllowed('__proto__', 'Selected')).toBe(false);
        const detached = m.getRegexScripts(); detached[0].replaceString = 'changed'; detached[1].placement.length = 0;
        expect(m.getRegexedString('xx', 1)).toBe('zz');
        const denied = frame(snapshot({ presetAllowed: {} })).module; await denied.initialize();
        expect(denied.getRegexScripts()).toHaveLength(2); expect(denied.getRegexScripts({ allowedOnly: true })).toHaveLength(1);
        expect(denied.getRegexedString('x', 1)).toBe('y');
    });
    test('rejects borrowed character/chat state and all native mutations before resource calls', async () => {
        const { module: m, calls } = frame(); await m.initialize();
        const before = calls.length;
        for (const method of ['allowScopedScripts', 'disallowScopedScripts', 'allowPresetScripts', 'disallowPresetScripts']) expect(() => m[method]({ avatar: 'ada.png' })).toThrow('scope confirmation');
        await expect(m.saveScriptsByType([], 0)).rejects.toThrow('native revision'); expect(calls).toHaveLength(before);
        for (const context of [{ characterId: 0 }, { groupId: 'team' }, { chat: [] }]) {
            const bound = frame(snapshot(), context).module; await bound.initialize();
            expect(() => bound.getRegexScripts()).toThrow('not bound');
        }
    });
    test('replaces captures, named groups, match aliases and trim strings with upstream replacement semantics', () => {
        const m = frame().module;
        expect(m.runRegexScript(rule({ findRegex: '/(?<first>a)(b)?/g', replaceString: '$<first>|$2|{{MATCH}}|$0|$$|$&', trimStrings: ['b'] }), 'ab a')).toBe('a||a|a|$$|$& a||a|a|$$|$&');
        expect(m.runRegexScript(rule({ findRegex: '/(a)/g', replaceString: '($1)', trimStrings: ['a'] }), 'a a')).toBe('() ()');
        expect(m.runRegexScript(rule({ findRegex: '/[/', replaceString: 'ignored' }), 'x')).toBe('x');
        expect(m.runRegexScript(rule({ disabled: true }), 'x')).toBe('x');
        expect(m.runRegexScript(null, 'x')).toBe('x');
        expect(m.runRegexScript(rule({ trimStrings: undefined }), 'x')).toBe('y');
    });
    test('fails explicitly only when execution needs an unbound macro context', () => {
        const m = frame().module;
        for (const substituteRegex of [1, 2]) {
            expect(m.runRegexScript(rule({ substituteRegex }), 'x')).toBe('y');
            expect(() => m.runRegexScript(rule({ findRegex: '{{char}}', substituteRegex }), 'x')).toThrow('macro context');
        }
        expect(() => m.runRegexScript(rule({ replaceString: '{{user}}' }), 'x')).toThrow('macro context');
        expect(() => m.runRegexScript(rule({ replaceString: '$0', trimStrings: ['{{char}}'] }), 'x')).toThrow('macro context');
        expect(() => m.runRegexScript(rule({ findRegex: '/(.*)/', replaceString: '$1' }), '{{user}}')).toThrow('macro context');
        expect(m.runRegexScript(rule({ replaceString: '{{user}}' }), 'unmatched')).toBe('unmatched');
        expect(m.runRegexScript(rule({ replaceString: '{{match}}' }), 'x')).toBe('x');
    });
    test('honors placements, depth, edit, markdown/prompt flags and the global enabled switch', async () => {
        const { module: m } = frame(snapshot({ presetScripts: [], scripts: [
            rule({ runOnEdit: true, minDepth: 1, maxDepth: 2 }),
            rule({ findRegex: '/x/g', replaceString: 'M', markdownOnly: true }),
            rule({ findRegex: '/x/g', replaceString: 'P', promptOnly: true }),
            rule({ findRegex: '/x/g', replaceString: 'R', placement: [6] }),
        ] })); await m.initialize();
        expect(m.getRegexedString('x', 1)).toBe('y'); expect(m.getRegexedString('x', 1, { isEdit: true, depth: 1 })).toBe('y');
        expect(m.getRegexedString('x', 1, { depth: 0 })).toBe('x'); expect(m.getRegexedString('x', 1, { depth: 3 })).toBe('x');
        expect(m.getRegexedString('x', 1, { isMarkdown: true })).toBe('M'); expect(m.getRegexedString('x', 1, { isPrompt: true })).toBe('P');
        expect(m.getRegexedString('x', 1, { isMarkdown: true, isEdit: true })).toBe('x');
        expect(m.getRegexedString('x', 6)).toBe('R'); expect(m.getRegexedString('x', 5)).toBe('x');
        expect(m.getRegexedString(null, 1)).toBe(''); expect(m.getRegexedString('x', undefined)).toBe('x');
        const disabled = frame(snapshot({ enabled: false })).module; await disabled.initialize(); expect(disabled.getRegexedString('x', 1)).toBe('x');
    });
});

describe('parent regex read snapshots', () => {
    test('projects only executable fields and scope lists with bounded authenticated GETs and cached replies', async () => {
        const f = fixture(), signal = new AbortController().signal;
        const read = createExtensionResourceReader(f.api, signal);
        const [a, b] = await Promise.all([read('regex.snapshot', {}), read('regex.snapshot', {})]);
        expect(a).toBe(b); expect(a.apiId).toBe('openai'); expect(a.presetName).toBe('Selected');
        expect(a.scripts).toEqual([rule()]); expect(a.presetScripts[0].replaceString).toBe('z');
        expect(JSON.stringify(a)).not.toMatch(/hidden|revision|opaque|custom_url|api_key/);
        expect(f.calls).toHaveLength(6); expect(f.calls.every(([, init]) => init.signal === signal && Object.keys(init).length === 1)).toBe(true);
        expect(await read('regex.snapshot', {})).toBe(a); expect(f.calls).toHaveLength(6);
        await expect(read('regex.snapshot', { path: '/settings' })).rejects.toThrow('Invalid');
        await expect(read('regex.save', {})).rejects.toThrow('Unsupported'); expect(f.calls).toHaveLength(6);
    });
    test('keeps unsupported main APIs unbound and supplies no fabricated preset scripts', async () => {
        const f = fixture(); f.settings.typed.main_api = 'textgenerationwebui';
        const value = await createExtensionResourceReader(f.api)('regex.snapshot', {});
        expect(value.apiId).toBeNull(); expect(value.presetName).toBeNull(); expect(value.presetScripts).toEqual([]); expect(f.calls).toHaveLength(4);
    });
    test.each(['regex', 'preset', 'api'])('rejects %s drift and latches failure instead of silently retrying', async drift => {
        const f = fixture(); let reads = 0;
        const read = createExtensionResourceReader(async (...args) => {
            const value = await f.api(...args);
            if (++reads > 3) {
                if (drift === 'regex' && args[0] === '/regex-settings') value.revision = 'new';
                if (drift === 'preset' && args[0].startsWith('/preset-settings/')) value.revision = 'new';
                if (drift === 'api' && args[0] === '/settings') value.typed.main_api = 'novel';
            }
            return value;
        });
        await expect(read('regex.snapshot', {})).rejects.toThrow('changed'); const count = f.calls.length;
        await expect(read('regex.snapshot', {})).rejects.toThrow('changed'); expect(f.calls).toHaveLength(count);
    });
    test('checks abort/session ownership around reads and cached replies', async () => {
        const f = fixture(), abort = new AbortController(); let current = true;
        const read = createExtensionResourceReader(f.api, abort.signal, { isCurrent: () => current }); await read('regex.snapshot', {});
        abort.abort(); await expect(read('regex.snapshot', {})).rejects.toThrow('aborted'); expect(f.calls).toHaveLength(6);
        const replaced = createExtensionResourceReader(async (...args) => { const value = await f.api(...args); current = false; return value; }, undefined, { isCurrent: () => current });
        await expect(replaced('regex.snapshot', {})).rejects.toThrow('replaced');
    });
    test.each([
        f => { f.document.settings.scripts = Array.from({ length: 513 }, () => rule()); },
        f => { f.document.settings.scripts[0].findRegex = 42; },
        f => { f.document.settings.scripts[0].placement = [4]; },
        f => { f.document.settings.scripts[0].trimStrings = [5]; },
        f => { f.document.settings.scripts[0].disabled = 'yes'; },
        f => { f.document.settings.scripts[0].maxDepth = 10001; },
        f => { f.document.settings.scripts[0].substituteRegex = 3; },
        f => { f.document.settings.scripts[0].id = {}; },
        f => { f.document.settings.characterAllowed = ['ada.png', 'ada.png']; },
        f => { f.document.settings.presetAllowed.openai = 'Selected'; },
        f => { f.document.settings.scripts[0].opaque = 'x'.repeat(1_048_576); },
        f => { f.active.preset.extensions.regex_scripts = {}; },
        f => { f.active.preset.extensions = []; },
        f => { f.active.preset.custom_url = 'x'.repeat(1_048_576); },
    ])('fails closed on malformed/oversized scripts and grants (%#)', async mutate => {
        const f = fixture(); mutate(f); const read = createExtensionResourceReader(f.api);
        await expect(read('regex.snapshot', {})).rejects.toThrow(/Invalid|oversized/);
    });
});
