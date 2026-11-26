import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, test } from '@jest/globals';

function load(file) {
    const { outputText } = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } });
    const exports = {}; new Function('exports', outputText)(exports); return exports;
}
const compiled = load('../client/lib/extension-runtime/compatibility.ts').installExtensionCompatibility;
const install = new Function(`return (${compiled.toString()});`)();
const { createExtensionResourceReader } = load('../client/lib/extension-runtime/resources.ts');
const unsupported = name => { throw Error(`Unsupported: ${name}`); };
function frame(request) { return install({}, { request, unsupported })['/scripts/world-info.js']; }
function fixture() {
    const document = { revision: 'wi-1', settings: { world_info_depth: 5, world_info_include_names: false, world_info: { globalSelect: ['Forest'], charLore: [{ name: 'ada', extraBooks: ['Ocean'], private: 'hidden' }], opaque: 'hidden' }, world_info_budget: 17, world_info_budget_cap: 555, world_info_overflow_alert: true, api_key: 'hidden' } };
    const listing = { books: [{ name: 'Forest', bytes: 123 }, { name: 'Ocean', bytes: 456 }], warnings: [] };
    const book = { entries: { 0: { key: ['forest'], content: 'lore' } } };
    const extensions = [
        { id: 'global/shared', type: 'global', api_key: 'hidden' },
        { id: 'builtin', type: 'system', hooks: ['hidden'] },
        { id: 'local/shared', type: 'local', settingsNamespace: 'hidden' },
        { id: 'global/other', type: 'global' },
    ];
    const calls = [];
    const api = async (path, init) => {
        calls.push([path, init]);
        if (path === '/world-info-settings') return structuredClone(document);
        if (path === '/world-info') return structuredClone(listing);
        if (path === '/world-info/Forest') return { name: 'Forest', revision: 'book-1', book: structuredClone(book) };
        if (path === '/extensions') return structuredClone(extensions);
        throw Error(`Unexpected path: ${path}`);
    };
    return { document, listing, extensions, book, calls, api };
}

describe('source-derived World Info interfaces', () => {
    test('loads detached settings/catalog/selection snapshots, scalar defaults and source constants', async () => {
        const f = fixture(), m = frame(createExtensionResourceReader(f.api));
        expect(() => m.getWorldInfoSettings()).toThrow('not loaded'); expect(() => m.world_names).toThrow('not loaded');
        expect(Object.keys(m)).not.toContain('initialize'); await m.initialize();
        expect(m.world_names).toEqual(['Forest', 'Ocean']); expect(m.selected_world_info).toEqual(['Forest']);
        expect(m.world_info_depth).toBe(5); expect(m.world_info_include_names).toBe(false);
        expect(m.world_info_character_strategy).toBe(1); expect(m.world_info_recursive).toBe(false);
        expect(m.scan_state).toEqual({ NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 });
        expect(m.getWorldInfoSettings()).not.toHaveProperty('world_info_budget');
        expect(m.getWorldInfoSettings()).not.toHaveProperty('world_info_overflow_alert');
        const settings = m.getWorldInfoSettings(); settings.world_info.globalSelect.length = 0; settings.world_info_depth = 0;
        const names = m.world_names; names.length = 0; const info = m.world_info; info.charLore[0].extraBooks.length = 0;
        expect(m.selected_world_info).toEqual(['Forest']); expect(m.world_names).toHaveLength(2); expect(m.world_info.charLore[0].extraBooks).toEqual(['Ocean']);
        expect(m.world_info_depth).toBe(5); expect(JSON.stringify(m.getWorldInfoSettings())).not.toContain('hidden');
        const other = frame(async () => { throw Error('Not initialized'); }); expect(() => other.world_info).toThrow('not loaded');
    });
    test('provides frame-local entry definitions/defaults without a backend call', () => {
        const m = frame(() => { throw Error('No requests'); });
        expect(Object.keys(m.newWorldInfoEntryDefinition)).toHaveLength(42);
        expect(m.newWorldInfoEntryTemplate).toMatchObject({ key: [], keysecondary: [], selective: true, depth: 4, role: 0, groupWeight: 100, delayUntilRecursion: 0, triggers: [] });
        for (const key of ['characterFilterNames', 'characterFilterTags', 'characterFilterExclude']) expect(m.newWorldInfoEntryTemplate).not.toHaveProperty(key);
        expect(m.newWorldInfoEntryDefinition.triggers.arrayFilter('normal')).toBe(true);
        expect(m.newWorldInfoEntryDefinition.triggers.arrayFilter('unknown')).toBe(false);
        m.newWorldInfoEntryTemplate.key.push('local'); expect(frame().newWorldInfoEntryTemplate.key).toEqual([]);
    });
    test('converts embedded card books with source IDs, aliases, defaults and extension mappings', () => {
        const m = frame();
        const book = { name: 'Embedded', entries: [
            { keys: ['first'], content: 'one', enabled: true, position: 'before_char', insertion_order: 42 },
            { id: 8, keys: ['second'], secondary_keys: ['secondary'], comment: 'note', content: 'two', enabled: false, constant: true, selective: true, extensions: { depth: 0, probability: 0, group: 'shared', sticky: 0, role: 2, match_persona_description: true, triggers: ['quiet'], unknown: 'keep' } },
        ], extensions: { vendor: true } };
        const result = m.convertCharacterBook(book);
        expect(result.originalData).toBe(book); expect(book.entries[0].id).toBe(0);
        expect(result.entries[0]).toMatchObject({ uid: 0, position: 0, selective: false, order: 42, delayUntilRecursion: false, disable: false, depth: 4 });
        expect(result.entries[8]).toMatchObject({ uid: 8, position: 1, depth: 0, probability: 0, group: 'shared', sticky: 0, role: 2, disable: true, matchPersonaDescription: true, triggers: ['quiet'] });
        expect(result.entries[0].key).toBe(book.entries[0].keys); expect(result.entries[8].extensions).toBe(book.entries[1].extensions);
        expect(result.entries[0].triggers).not.toBe(m.newWorldInfoEntryTemplate.triggers);
        expect(result.entries[8].extensions.unknown).toBe('keep');
    });
    test('retains duplicate-ID overwrite semantics without a prototype setter side effect', () => {
        const m = frame();
        const result = m.convertCharacterBook({ entries: [{ id: '__proto__', content: 'safe' }, { id: 2, content: 'first' }, { id: 2, content: 'last' }] });
        expect(Object.getPrototypeOf(result.entries)).toBe(Object.prototype);
        expect(Object.hasOwn(result.entries, '__proto__')).toBe(true); expect(result.entries.__proto__.content).toBe('safe');
        expect(result.entries[2].content).toBe('last'); expect({}.content).toBeUndefined();
    });
    test('keeps named book loading and rejects native writes/scans/UI operations before dispatch', async () => {
        const f = fixture(), m = frame(createExtensionResourceReader(f.api));
        expect(await m.loadWorldInfo('Forest')).toEqual(f.book); expect(await m.loadWorldInfo('')).toBeUndefined();
        const count = f.calls.length;
        for (const name of ['saveWorldInfo', 'deleteWorldInfo', 'createNewWorldInfo', 'getWorldInfoPrompt', 'getSortedEntries', 'checkWorldInfo', 'updateWorldInfoList']) await expect(m[name]('Forest', {})).rejects.toThrow('lifecycle is not bound');
        for (const name of ['setWorldInfoButtonClass', 'setWorldInfoSettings', 'updateWorldInfoSettings', 'initWorldInfo']) expect(() => m[name]({})).toThrow('lifecycle is not bound');
        expect(f.calls).toHaveLength(count);
    });
});

describe('parent World Info read snapshots', () => {
    test('projects only supported settings/bindings and caches verified GETs', async () => {
        const f = fixture(), signal = new AbortController().signal; const read = createExtensionResourceReader(f.api, signal);
        const [a, b] = await Promise.all([read('worldInfo.snapshot', {}), read('worldInfo.snapshot', {})]);
        expect(a).toBe(b); expect(a.names).toEqual(['Forest', 'Ocean']); expect(a.selected).toEqual(['Forest']);
        expect(a.settings).toEqual({ world_info_depth: 5, world_info_include_names: false, world_info: { globalSelect: ['Forest'], charLore: [{ name: 'ada', extraBooks: ['Ocean'] }] } });
        expect(JSON.stringify(a)).not.toMatch(/revision|hidden|budget|overflow/);
        expect(f.calls).toHaveLength(4); expect(f.calls.every(([, init]) => Object.keys(init).length === 1 && init.signal === signal)).toBe(true);
        expect(await read('worldInfo.snapshot', {})).toBe(a); expect(f.calls).toHaveLength(4);
        await expect(read('worldInfo.snapshot', { path: '/settings' })).rejects.toThrow('Invalid');
    });
    test.each(['Forest', ['Forest']])('reads legacy book selections without mutating storage (%j)', async legacy => {
        const f = fixture(); f.document.settings.world_info = legacy;
        const value = await createExtensionResourceReader(f.api)('worldInfo.snapshot', {});
        expect(value.selected).toEqual(['Forest']); expect(value.settings.world_info).toEqual({}); expect(f.document.settings.world_info).toEqual(legacy);
    });
    test.each(['settings', 'catalog'])('rejects %s drift and retains failed snapshot without replay', async kind => {
        const f = fixture(); let count = 0;
        const read = createExtensionResourceReader(async (...args) => {
            const value = await f.api(...args);
            if (++count > 2 && args[0] === (kind === 'settings' ? '/world-info-settings' : '/world-info')) {
                if (kind === 'settings') value.revision = 'changed'; else value.books[0].bytes++;
            }
            return value;
        });
        await expect(read('worldInfo.snapshot', {})).rejects.toThrow('changed'); const calls = f.calls.length;
        await expect(read('worldInfo.snapshot', {})).rejects.toThrow('changed'); expect(f.calls).toHaveLength(calls);
    });
    test('checks abort and session replacement for snapshot and named-book replies', async () => {
        const f = fixture(), abort = new AbortController();
        const read = createExtensionResourceReader(f.api, abort.signal); await read('worldInfo.snapshot', {}); abort.abort();
        await expect(read('worldInfo.snapshot', {})).rejects.toThrow('aborted');
        let current = true;
        const replaced = createExtensionResourceReader(async (...args) => { const value = await f.api(...args); current = false; return value; }, undefined, { isCurrent: () => current });
        await expect(replaced('worldInfo.load', { name: 'Forest' })).rejects.toThrow('replaced');
        current = true;
        await expect(replaced('worldInfo.snapshot', {})).rejects.toThrow('replaced');
    });
    test.each([
        f => { f.listing.warnings = [{ name: 'bad' }]; },
        f => { f.listing.books.push(f.listing.books[0]); },
        f => { f.listing.books = Array.from({ length: 513 }, (_, n) => ({ name: String(n), bytes: 1 })); },
        f => { f.listing.books[0].name = '../escape'; },
        f => { f.listing.books[0].bytes = 4_194_305; },
        f => { f.document.settings.opaque = 'x'.repeat(1_048_576); },
        f => { f.document.settings.world_info_depth = 1001; },
        f => { f.document.settings.world_info_include_names = 'false'; },
        f => { f.document.settings.world_info.globalSelect = ['Forest', 'Forest']; },
        f => { f.document.settings.world_info.globalSelect = ['Missing']; },
        f => { f.document.settings.world_info.charLore[0].extraBooks = ['Missing']; },
        f => { f.document.settings.world_info.charLore.push(f.document.settings.world_info.charLore[0]); },
        f => { f.document.settings.world_info.charLore[0].name = '../escape'; },
    ])('fails on invalid/oversized catalogs and bindings without publishing partial data (%#)', async mutate => {
        const f = fixture(); mutate(f); await expect(createExtensionResourceReader(f.api)('worldInfo.snapshot', {})).rejects.toThrow();
    });
});

describe('parent extension identity catalog', () => {
    test('uses upstream IDs and local-over-global precedence while excluding manifests/settings', async () => {
        const f = fixture(), read = createExtensionResourceReader(f.api);
        const value = await read('extensions.catalog', {});
        expect(value).toEqual({ names: ['builtin', 'third-party/shared', 'third-party/other'], types: { builtin: 'system', 'third-party/shared': 'local', 'third-party/other': 'global' } });
        expect(JSON.stringify(value)).not.toContain('hidden'); expect(await read('extensions.catalog', {})).toBe(value); expect(f.calls).toHaveLength(1);
        await expect(read('extensions.catalog', { id: 'other' })).rejects.toThrow('Invalid');
    });
    test.each([
        f => { f.extensions.push(f.extensions[0]); },
        f => { f.extensions[0].id = 'local/../bad'; },
        f => { f.extensions[0].id = 'elsewhere/name'; },
        f => { f.extensions[0].type = 'local'; },
        f => { f.extensions[0].opaque = 'x'.repeat(1_048_576); },
        f => { f.extensions.push(...Array.from({ length: 513 }, (_, index) => ({ id: `local/extra-${index}`, type: 'local' }))); },
    ])('rejects invalid catalogs and caches failure (%#)', async mutate => {
        const f = fixture(); mutate(f); const read = createExtensionResourceReader(f.api);
        await expect(read('extensions.catalog', {})).rejects.toThrow('Invalid');
        const count = f.calls.length; await expect(read('extensions.catalog', {})).rejects.toThrow('Invalid'); expect(f.calls).toHaveLength(count);
    });
    test('rejects cached replies and in-flight responses after abort/session replacement', async () => {
        const f = fixture(), abort = new AbortController();
        const read = createExtensionResourceReader(f.api, abort.signal); await read('extensions.catalog', {}); abort.abort();
        await expect(read('extensions.catalog', {})).rejects.toThrow('aborted');
        let current = true;
        const replaced = createExtensionResourceReader(async (...args) => { const result = await f.api(...args); current = false; return result; }, undefined, { isCurrent: () => current });
        await expect(replaced('extensions.catalog', {})).rejects.toThrow('replaced');
    });
});
