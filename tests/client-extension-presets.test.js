import fs from 'node:fs';
import ts from 'typescript';
import lodash from 'lodash';
import { describe, expect, test } from '@jest/globals';

function load(file) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } });
    const exports = {}; new Function('exports', outputText)(exports); return exports;
}
const compiled = load('../client/lib/extension-runtime/presets.ts').installExtensionPresets;
const install = new Function(`return (${compiled.toString()});`)();
const { createExtensionResourceReader } = load('../client/lib/extension-runtime/resources.ts');
const { PRESET_SETTING_KEYS } = load('../src/headless/preset-mapping.ts');
const kinds = ['chat-completion', 'context', 'instruct', 'sysprompt'];
function fixture() {
    const data = Object.fromEntries(kinds.map(kind => [kind, {
        catalog: { kind, activeName: 'Alpha', activeRevision: `active-${kind}`, presets: [{ name: 'Alpha', revision: 'rev-a', origin: 'user' }, { name: 'Beta # %', revision: 'rev-b', origin: 'builtin' }], warnings: [] },
        active: { kind, name: 'Alpha', revision: `active-${kind}`, preset: { temperature: 0.8, extensions: { demo: { source: 'active', items: [{ value: 3 }], 'literal.key': 'literal' } }, custom_url: 'https://private.invalid', api_key: 'private', custom_include_body: 'private' } },
        documents: {
            Alpha: { kind, name: 'Alpha', revision: 'rev-a', origin: 'user', preset: { temperature: 0.7, extensions: { demo: { source: 'file' }, nested: { token: 'private', keep: true } } }, connectionSettings: { custom_url: 'private' } },
            'Beta # %': { kind, name: 'Beta # %', revision: 'rev-b', origin: 'builtin', preset: { name: 'Beta # %', extensions: { demo: { source: 'named' }, secret: 'private', nested: { api_key: 'private', keep: true } }, proxy_password: 'private', reverse_proxy: 'https://private.invalid', custom_include_headers: 'private' } },
        },
    }]));
    const calls = []; let mainApi = 'openai';
    const api = async (path, init) => {
        calls.push([path, init]);
        if (path === '/settings') return { typed: { main_api: mainApi } };
        const [, resource, kind, encoded] = path.split('/');
        if (!data[kind]) throw Error(`Unexpected kind: ${path}`);
        if (resource === 'preset-settings') return structuredClone(data[kind].active);
        if (resource === 'presets' && encoded === undefined) return structuredClone(data[kind].catalog);
        if (resource === 'presets') return structuredClone(data[kind].documents[decodeURIComponent(encoded)]);
        throw Error(`Unexpected path: ${path}`);
    };
    return { data, calls, api, setMainApi: value => { mainApi = value; } };
}
function frame(request) {
    return install({ _: lodash }, { request, settingKeys: PRESET_SETTING_KEYS, unsupported: name => { throw Error(`Unsupported: ${name}`); } })['/scripts/preset-manager.js'];
}

describe('read-only upstream preset managers', () => {
    test('initializes four catalogs and maps default API, names and DOM-style values without exposing a selector', async () => {
        const mock = fixture();
        const module = frame(createExtensionResourceReader(mock.api));
        expect(module.getPresetManager('unknown')).toBeNull();
        expect(module.getPresetManager('koboldhorde')).toBeNull();
        expect(() => module.getPresetManager()).toThrow('not loaded');
        expect(Object.keys(module)).not.toContain('initialize');
        await module.initialize();
        const manager = module.getPresetManager();
        expect(manager).toBe(module.getPresetManager('openai'));
        expect(manager.apiId).toBe('openai');
        expect(manager.getAllPresets()).toEqual(['Alpha', 'Beta # %']);
        expect(manager.getSelectedPreset()).toBe('0');
        expect(manager.getSelectedPresetName()).toBe('Alpha');
        expect(manager.findPreset('Beta # %')).toBe('1');
        expect(manager.findPreset('alpha')).toBeUndefined();
        expect(manager.isKeyedApi()).toBe(false); expect(manager.isAdvancedFormatting()).toBe(false);
        const context = module.getPresetManager('context');
        expect(context.findPreset('Beta # %')).toBe('Beta # %');
        expect(context.getSelectedPreset()).toBe('Alpha');
        expect(context.isKeyedApi()).toBe(true); expect(context.isAdvancedFormatting()).toBe(true);
        expect(() => manager.select).toThrow('selector DOM');
        expect(() => manager.getPresetList('unknown')).toThrow('preset manager API');
    });
    test('returns detached lists/content and active extension fields instead of saved selected-file values', async () => {
        const mock = fixture(); const module = frame(createExtensionResourceReader(mock.api)); await module.initialize();
        const manager = module.getPresetManager();
        const list = manager.getPresetList();
        expect(list.preset_names).toEqual({ Alpha: 0, 'Beta # %': 1 });
        expect(list.settings.temp_openai).toBe(0.8); expect(list.settings.temperature).toBeUndefined();
        expect(list.presets[0].temperature).toBe(0.7);
        expect(manager.getCompletionPresetByName('missing')).toBeUndefined();
        expect(manager.readPresetExtensionField({ path: 'demo.source' })).toBe('active');
        expect(manager.readPresetExtensionField({ name: 'Alpha', path: 'demo.items[0].value' })).toBe(3);
        expect(manager.readPresetExtensionField({ path: ['demo', 'literal.key'] })).toBe('literal');
        expect(manager.readPresetExtensionField({ name: 'Beta # %', path: 'demo.source' })).toBe('named');
        expect(manager.readPresetExtensionField({ name: 'missing' })).toBeNull();
        expect(manager.readPresetExtensionField({ path: 'demo.missing' })).toBeNull();
        expect(manager.readPresetExtensionField({ path: '__proto__' })).toBeNull();
        expect(manager.readPresetExtensionField({ path: 'demo.constructor' })).toBeNull();
        list.settings.extensions.demo.source = 'changed'; list.presets[0].temperature = 0;
        const extensions = manager.readPresetExtensionField({}); extensions.demo.source = 'changed';
        expect(manager.readPresetExtensionField({ path: 'demo.source' })).toBe('active');
        expect(manager.getCompletionPresetByName('Alpha').temperature).toBe(0.7);
        expect(manager.getPresetList('context').preset_names).toEqual(['Alpha', 'Beta # %']);
    });
    test('rejects all mutation, default restoration and live UI APIs before resource dispatch', async () => {
        const mock = fixture(); const module = frame(createExtensionResourceReader(mock.api)); await module.initialize();
        const before = mock.calls.length, manager = module.getPresetManager();
        for (const method of ['selectPreset', 'updatePreset', 'savePresetAs', 'savePreset', 'renamePreset', 'deletePreset', 'writePresetExtensionField', 'getDefaultPreset']) await expect(manager[method]('Alpha', {})).rejects.toThrow('not bound');
        for (const method of ['updateList', 'getPresetSettings']) expect(() => manager[method]('Alpha', {})).toThrow('not bound');
        await expect(module.initPresetManager()).rejects.toThrow('upstream DOM');
        expect(mock.calls).toHaveLength(before);
    });
    test('isolates frames and does not claim unsupported active-provider compatibility', async () => {
        const mock = fixture(); mock.setMainApi('textgenerationwebui');
        const module = frame(createExtensionResourceReader(mock.api)); await module.initialize();
        expect(module.getPresetManager()).toBeNull();
        expect(module.getPresetManager('instruct')).not.toBeNull();
        expect(() => frame(async () => { throw Error('not requested'); }).getPresetManager('openai')).toThrow('not loaded');
    });
});

describe('parent preset snapshots', () => {
    test('uses bounded authenticated GETs, projects private fields recursively and caches one completed snapshot', async () => {
        const mock = fixture(); const signal = new AbortController().signal;
        const read = createExtensionResourceReader(mock.api, signal);
        const [a, b] = await Promise.all([read('presets.snapshot', {}), read('presets.snapshot', {})]);
        expect(a).toBe(b); expect(a.mainApi).toBe('openai'); expect(a.catalogs).toHaveLength(4);
        expect(a.catalogs[0].settings).toEqual({ temperature: 0.8, extensions: { demo: { source: 'active', items: [{ value: 3 }], 'literal.key': 'literal' } } });
        expect(a.catalogs[0].presets[1].preset.extensions).toEqual({ demo: { source: 'named' }, nested: { keep: true } });
        expect(JSON.stringify(a)).not.toContain('private'); expect(JSON.stringify(a)).not.toContain('connectionSettings');
        expect(mock.calls).toHaveLength(22);
        expect(mock.calls.every(([, init]) => Object.keys(init).length === 1 && init.signal === signal)).toBe(true);
        expect(mock.calls.some(([path]) => path.endsWith('Beta%20%23%20%25'))).toBe(true);
        expect(await read('presets.snapshot', {})).toBe(a); expect(mock.calls).toHaveLength(22);
        await expect(read('presets.snapshot', { kind: '../settings' })).rejects.toThrow('Invalid');
        await expect(read('presets.activate', {})).rejects.toThrow('Unsupported');
        expect(mock.calls).toHaveLength(22);
    });
    test('bounds request concurrency and refuses to publish a snapshot after session replacement', async () => {
        const mock = fixture(); let inFlight = 0, maximum = 0, current = true;
        const read = createExtensionResourceReader(async (...args) => {
            inFlight++; maximum = Math.max(maximum, inFlight);
            await new Promise(resolve => setImmediate(resolve));
            try { return await mock.api(...args); } finally { inFlight--; }
        }, undefined, { isCurrent: () => current });
        await read('presets.snapshot', {}); expect(maximum).toBeLessThanOrEqual(4); expect(maximum).toBeGreaterThan(1);
        current = false; await expect(read('presets.snapshot', {})).rejects.toThrow('replaced');
        let changed = false;
        const stale = createExtensionResourceReader(async (...args) => { const result = await mock.api(...args); changed = true; return result; }, undefined, { isCurrent: () => !changed });
        await expect(stale('presets.snapshot', {})).rejects.toThrow('replaced');
    });
    test('rejects mismatched file/active revisions and catalog drift without retrying failed initialization', async () => {
        for (const type of ['file', 'active', 'catalog', 'api']) {
            const mock = fixture(); let catalogReads = 0, settingsReads = 0;
            const read = createExtensionResourceReader(async (...args) => {
                const result = await mock.api(...args);
                if (args[0] === '/presets/chat-completion/Alpha' && type === 'file') result.revision = 'changed';
                if (args[0] === '/preset-settings/chat-completion' && type === 'active') result.revision = 'changed';
                if (args[0] === '/presets/chat-completion' && ++catalogReads > 1 && type === 'catalog') result.activeRevision = 'changed';
                if (args[0] === '/settings' && ++settingsReads > 1 && type === 'api') result.typed.main_api = 'different';
                return result;
            });
            await expect(read('presets.snapshot', {})).rejects.toThrow(/changed/i);
            // Let already-started read-only jobs drain before checking no replay.
            await new Promise(resolve => setImmediate(resolve));
            const calls = mock.calls.length;
            await expect(read('presets.snapshot', {})).rejects.toThrow(/changed/i);
            expect(mock.calls).toHaveLength(calls);
        }
    });
    test('rejects unsafe names, unreadable catalogs, duplicates and oversized inventories', async () => {
        for (const mutate of [
            value => { value.presets[0].name = '../escape'; },
            value => { value.presets.push({ ...value.presets[0] }); },
            value => { value.warnings.push({ name: 'broken', message: 'Unreadable' }); },
            value => { value.presets = Array.from({ length: 129 }, (_, i) => ({ name: `preset-${i}`, revision: 'rev', origin: 'user' })); },
        ]) {
            const mock = fixture(); mutate(mock.data['chat-completion'].catalog);
            const read = createExtensionResourceReader(mock.api);
            await expect(read('presets.snapshot', {})).rejects.toThrow(/catalog/i);
            expect(mock.calls.some(([path]) => path === '/presets/chat-completion/Alpha')).toBe(false);
        }
    });
    test('rejects oversized/deep documents and cached replies after an abort', async () => {
        const oversized = fixture(); oversized.data['chat-completion'].documents.Alpha.preset.content = 'x'.repeat(1_048_576);
        await expect(createExtensionResourceReader(oversized.api)('presets.snapshot', {})).rejects.toThrow('oversized');
        const deep = fixture(); let node = deep.data['chat-completion'].documents.Alpha.preset;
        for (let i = 0; i < 65; i++) { node.child = {}; node = node.child; }
        await expect(createExtensionResourceReader(deep.api)('presets.snapshot', {})).rejects.toThrow('nesting');
        const mock = fixture(), abort = new AbortController(); const read = createExtensionResourceReader(mock.api, abort.signal);
        await read('presets.snapshot', {}); abort.abort();
        await expect(read('presets.snapshot', {})).rejects.toThrow('aborted');
    });
    test('bounds aggregate file count and document bytes before publishing any catalog', async () => {
        const many = fixture();
        for (const kind of kinds) many.data[kind].catalog.presets = Array.from({ length: 65 }, (_, index) => ({ name: `preset-${index}`, revision: 'rev', origin: 'user' }));
        await expect(createExtensionResourceReader(many.api)('presets.snapshot', {})).rejects.toThrow('256 presets');
        const large = fixture();
        for (const kind of kinds) {
            large.data[kind].active.preset.content = 'x'.repeat(800_000);
            for (const doc of Object.values(large.data[kind].documents)) doc.preset.content = 'x'.repeat(800_000);
        }
        await expect(createExtensionResourceReader(large.api)('presets.snapshot', {})).rejects.toThrow('8 MiB');
    });
});
