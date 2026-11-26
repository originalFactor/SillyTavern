import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, test } from '@jest/globals';

function load(file, name) {
    const source = fs.readFileSync(new URL(`../client/lib/extension-runtime/${file}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } });
    const exports = {}; new Function('exports', outputText)(exports);
    return new Function(`return (${exports[name].toString()});`)();
}
const reader = load('resources', 'createExtensionResourceReader');
const install = load('script', 'installExtensionScript');
const clone = value => JSON.parse(JSON.stringify(value));
const cards = ['other', 'ada'].map(id => ({ id, avatar: `${id}.png`, name: id, revision: `${id}-1`, data: { name: id, description: `${id} description`, first_mes: 'Hello', extensions: { vendor: { keep: true } } }, raw: { spec: 'chara_card_v3', spec_version: '3.0', opaque: { keep: true }, data: { name: id, first_mes: 'Hello', extensions: { vendor: { keep: true } } } } }));
const listing = cards.map(({ id, avatar, name, revision }) => ({ id, avatar, name, revision }));
function native(options = {}, transform = (_path, value) => value) {
    const calls = [];
    const read = reader(async (path, init) => {
        calls.push([path, init]);
        if (path === '/provider-status') return { onlineStatus: 'no_connection', state: 'unchecked', checkedAt: null };
        if (path.includes('/snapshot')) return { characterId: options.selection?.id, groupId: options.selection?.id, chatId: options.selection?.chatId, revision: 'a'.repeat(64), headerPresent: true, messages: [], chatMetadata: {} };
        const value = path === '/characters' ? listing : cards.find(card => path === `/characters/${card.id}`);
        if (!value) throw Error('Unexpected path');
        return transform(path, clone(value), calls.length);
    }, options.signal, options);
    return { read, calls };
}
function script(read) {
    const calls = [];
    const module = install({}, {
        utils: {}, cleanup: { async initialize() { calls.push('cleanup'); } },
        unsupported(name) { throw Error(name); },
        request: async (...args) => { calls.push(args); return await read(...args); },
    });
    return { module, calls };
}

describe('native extension character catalog and parent-owned selection', () => {
    test('loads the complete catalog in native order and maps selection to its array index, never the native slug', async () => {
        const selection = { kind: 'character', id: 'ada', chatId: 'chosen chat' };
        const { read, calls } = native({ selection });
        selection.id = 'other'; selection.chatId = 'retargeted';
        const snapshot = await read('characters.snapshot', {});
        expect(snapshot).toMatchObject({ characterId: 1, chatId: 'chosen chat' });
        expect(snapshot).not.toHaveProperty('groupId');
        expect(snapshot.characters.map(row => row.avatar)).toEqual(['other.png', 'ada.png']);
        expect(snapshot.characters[0]).not.toHaveProperty('chat');
        expect(snapshot.characters[1]).toMatchObject({ name: 'ada', chat: 'chosen chat', first_mes: 'Hello', shallow: false, opaque: { keep: true }, data: cards[1].raw.data });
        expect(snapshot.characters[1]).not.toHaveProperty('revision');
        expect(await read('characters.snapshot', {})).toBe(snapshot);
        expect(calls.map(([path]) => path)).toEqual(['/characters', '/characters/other', '/characters/ada', '/characters']);
        expect(calls.every(([, init]) => init.method === undefined)).toBe(true);
    });
    test.each([undefined, { kind: 'group', id: 'team', chatId: 'shared' }])('retains a real directory without inventing a selected character for %j', async selection => {
        const { read } = native({ selection });
        const result = await read('characters.snapshot', {});
        expect(result).not.toHaveProperty('characterId');
        expect(result.characters).toHaveLength(2);
        if (selection) expect(result).toMatchObject({ groupId: 'team', chatId: 'shared' });
        else expect(Object.keys(result)).toEqual(['characters']);
    });
    test('links lazy exports, freezes nested snapshots and preserves no-fetch unshallow semantics', async () => {
        const { read } = native({ selection: { kind: 'character', id: 'ada', chatId: 'chosen' } });
        const { module, calls } = script(read);
        for (const key of ['characters', 'this_chid']) expect(() => module[key]).toThrow('snapshot is not loaded');
        expect(Object.keys(module)).not.toContain('initialize');
        expect(Object.keys(module)).not.toContain('selectionGroupId');
        await Promise.all([module.initialize(), module.initialize()]);
        expect(calls).toEqual(['cleanup', ['characters.snapshot', {}], ['chat.snapshot', {}], ['provider.status', {}]]);
        expect(module.this_chid).toBe(1); expect(module.getCurrentChatId()).toBe('chosen');
        expect(module.name2).toBe('ada');
        expect(module.selectionGroupId).toBeUndefined();
        expect(Object.isFrozen(module.characters)).toBe(true);
        expect(() => module.characters.push({})).toThrow(TypeError);
        expect(() => { module.characters[1].data.extensions.vendor.keep = false; }).toThrow(TypeError);
        for (const id of [undefined, 0, '1', null, 'missing', -1]) await expect(module.unshallowCharacter(id)).resolves.toBeUndefined();
        expect(calls).toHaveLength(4);
        await expect(module.saveChatConditional()).rejects.toThrow('transcript persistence lifecycle');
        await expect(module.getCharacters()).rejects.toThrow('not bound');
    });
    test('preserves group and empty-directory/no-selection results without placeholders', async () => {
        const grouped = script(native({ selection: { kind: 'group', id: 'team', chatId: 'shared' } }).read).module;
        await grouped.initialize();
        expect(grouped.name2).toBe('');
        expect(grouped.this_chid).toBeUndefined(); expect(grouped.selectionGroupId).toBe('team'); expect(grouped.getCurrentChatId()).toBe('shared');
        const empty = script(reader(async path => path === '/provider-status' ? { onlineStatus: 'no_connection', state: 'unchecked', checkedAt: null } : [])).module;
        await empty.initialize(); expect(empty.characters).toEqual([]); expect(empty.this_chid).toBeUndefined(); expect(empty.getCurrentChatId()).toBeUndefined();
        expect(empty.name2).toBe('SillyTavern System');
    });
    test('retains the exact first selected card name without normalization or a descriptor-name fallback', async () => {
        const exactName = '  名称 😀  ';
        const fixture = native({ selection: { kind: 'character', id: 'other', chatId: 'chosen' } }, (path, value) => path === '/characters' ? value.map(row => row.id === 'other' ? { ...row, name: exactName } : row) : value.id === 'other' ? { ...value, name: exactName } : value);
        const { module } = script(fixture.read);
        await module.initialize();
        expect(module.this_chid).toBe(0); expect(module.name2).toBe(exactName);
        expect(() => { module.name2 = 'Retargeted'; }).toThrow(TypeError);
        expect(() => { module.characters[0].name = 'Renamed'; }).toThrow(TypeError);
        expect(module.name2).toBe(exactName);
    });
    test('validates exact empty arguments and parent selection before making any requests', async () => {
        const { read, calls } = native();
        for (const args of [undefined, null, [], 0, { characterId: 'other' }, { chatId: 'other' }, { path: '/settings' }]) await expect(read('characters.snapshot', args)).rejects.toThrow('Invalid');
        expect(calls).toHaveLength(0);
        for (const selection of [{ kind: 'wrong', id: 'ada', chatId: 'chosen' }, { kind: 'character', id: '../ada', chatId: 'chosen' }, { kind: 'group', id: 'team', chatId: 'a/b' }]) {
            const fixture = native({ selection }); await expect(fixture.read('characters.snapshot', {})).rejects.toThrow('Invalid native'); expect(fixture.calls).toHaveLength(0);
        }
    });
    test('rejects missing selections, corrupt inventories and oversized catalogs instead of partial data', async () => {
        await expect(native({ selection: { kind: 'character', id: 'missing', chatId: 'chosen' } }).read('characters.snapshot', {})).rejects.toThrow('missing');
        for (const value of [null, {}, Array(513).fill(listing[0]), [listing[0], listing[0]], [{ ...listing[0], revision: undefined }], [{ ...listing[0], avatar: '../other.png' }], [{ ...listing[0], name: 'x'.repeat(1_048_576) }]]) {
            const { read, calls } = native({}, () => value);
            await expect(read('characters.snapshot', {})).rejects.toThrow(/Invalid|oversized/);
            expect(calls).toHaveLength(1);
        }
    });
    test('rejects corrupt/mismatched cards and detects changes in the final directory reread', async () => {
        for (const patch of [{ revision: 'new' }, { id: 'wrong' }, { avatar: 'wrong.png' }, { name: 'wrong' }, { raw: [] }, { data: null }, { raw: { tooBig: 'x'.repeat(4_194_304) } }]) {
            const { read } = native({}, (path, value) => path === '/characters/other' ? { ...value, ...patch } : value);
            await expect(read('characters.snapshot', {})).rejects.toThrow(/Invalid|changed/);
        }
        for (const update of [value => value.reverse(), value => value.slice(1), value => value.map(row => ({ ...row, revision: 'changed' }))]) {
            const { read } = native({}, (path, value, count) => path === '/characters' && count > 1 ? update(value) : value);
            await expect(read('characters.snapshot', {})).rejects.toThrow('catalog changed');
        }
    });
    test('enforces the aggregate 16 MiB limit without exposing a partial snapshot', async () => {
        const largeCards = Array.from({ length: 5 }, (_, index) => ({ ...clone(cards[0]), id: `c${index}`, avatar: `c${index}.png`, raw: { payload: 'x'.repeat(3_500_000) } }));
        const read = reader(async path => path === '/characters' ? largeCards.map(({ id, avatar, name, revision }) => ({ id, avatar, name, revision })) : largeCards.find(card => path === `/characters/${card.id}`));
        await expect(read('characters.snapshot', {})).rejects.toThrow('16 MiB');
    });
    test.each(['abort', 'replace'])('discards delayed responses on session %s and never silently retries failed initialization', async mode => {
        const controller = new AbortController(); let current = true, finish, requests = 0;
        const read = reader(async () => { requests++; return await new Promise(resolve => { finish = resolve; }); }, controller.signal, { isCurrent: () => current });
        const { module, calls } = script(read);
        const pending = module.initialize(); await Promise.resolve();
        if (mode === 'abort') controller.abort(); else current = false;
        finish(null); await expect(pending).rejects.toThrow('replaced or aborted');
        current = true;
        await expect(module.initialize()).rejects.toThrow('replaced or aborted');
        expect(requests).toBe(1); expect(calls).toHaveLength(2);
        expect(() => module.characters).toThrow('not loaded');
    });
});

describe('parent-scoped complete transcript snapshots', () => {
    const selection = { kind: 'character', id: 'Ada space', chatId: 'First chat' };
    const response = () => ({ characterId: selection.id, chatId: selection.chatId, revision: 'a'.repeat(64), headerPresent: true, chatMetadata: { variables: { keep: 'yes' }, vendor: { nested: true } }, messages: [{ name: 'Ada', mes: '{{user}} literal', extra: { reasoning: 'raw', future: true } }] });
    test('encodes only the parent-selected target and keeps metadata/messages from the same cached read', async () => {
        const calls = [], controller = new AbortController();
        const read = reader(async (...args) => { calls.push(args); return response(); }, controller.signal, { selection });
        const result = await read('chat.snapshot', {});
        expect(result).toEqual({ bound: true, chat: response().messages, chatMetadata: response().chatMetadata });
        expect(calls).toEqual([['/chats/First%20chat/snapshot?characterId=Ada%20space', { signal: controller.signal }]]);
        expect(await read('chat.snapshot', {})).toBe(result); expect(calls).toHaveLength(1);
    });
    test('uses the authorized group snapshot path and accepts explicitly headerless history', async () => {
        const calls = [];
        const read = reader(async path => { calls.push(path); return { ...response(), characterId: undefined, groupId: 'team', headerPresent: false }; }, undefined, { selection: { kind: 'group', id: 'team', chatId: selection.chatId } });
        expect((await read('chat.snapshot', {})).chat).toEqual(response().messages);
        expect(calls).toEqual(['/groups/team/chats/First%20chat/snapshot']);
    });
    test('reports genuine no-selection initial state without attempting a native chat read', async () => {
        const read = reader(async () => { throw Error('A settings frame cannot choose a chat'); });
        expect(await read('chat.snapshot', {})).toEqual({ bound: false, chat: [], chatMetadata: {} });
    });
    test('does not let the frame supply target IDs, paths, methods or arbitrary request data', async () => {
        let calls = 0;
        const read = reader(async () => { calls++; return response(); }, undefined, { selection });
        for (const args of [null, [], 'x', { characterId: 'other' }, { chatId: 'other' }, { path: '/settings' }, { method: 'POST' }]) await expect(read('chat.snapshot', args)).rejects.toThrow('Invalid');
        expect(calls).toBe(0);
    });
    test('rejects mismatched, incomplete and oversized responses without empty fallbacks or retries', async () => {
        for (const patch of [{ chatId: 'other' }, { characterId: 'other' }, { revision: '' }, { revision: 'x'.repeat(64) }, { headerPresent: false }, { headerPresent: undefined }, { messages: null }, { messages: [null] }, { messages: [{ chat_metadata: {} }] }, { chatMetadata: [] }, { messages: Array(10001).fill({ mes: 'x' }) }, { chatMetadata: { huge: 'x'.repeat(8_392_704) } }]) {
            let calls = 0;
            const read = reader(async () => { calls++; return { ...response(), ...patch }; }, undefined, { selection });
            await expect(read('chat.snapshot', {})).rejects.toThrow('complete chat snapshot');
            await expect(read('chat.snapshot', {})).rejects.toThrow('complete chat snapshot');
            expect(calls).toBe(1);
        }
        const read = reader(async () => { throw Error('Corrupt transcript'); }, undefined, { selection });
        await expect(read('chat.snapshot', {})).rejects.toThrow('Corrupt transcript');
    });
    test('freezes shared message and metadata graphs and does not publish partial character initialization if transcript loading fails', async () => {
        const { module } = script(async operation => operation === 'characters.snapshot' ? { characters: clone(cards) } : operation === 'provider.status' ? 'no_connection' : { bound: true, chat: response().messages, chatMetadata: response().chatMetadata });
        await module.initialize();
        expect(module.chat).toEqual(response().messages); expect(module.chat_metadata).toEqual(response().chatMetadata);
        expect(Object.isFrozen(module.chat[0].extra)).toBe(true);
        expect(() => { module.chat_metadata.variables.keep = 'changed'; }).toThrow(TypeError);
        expect(() => { module.chat[0].mes = 'changed'; }).toThrow(TypeError);
        const failed = script(async operation => { if (operation === 'characters.snapshot') return { characters: clone(cards) }; throw Error('Chat read failed'); }).module;
        await expect(failed.initialize()).rejects.toThrow('Chat read failed');
        expect(() => failed.characters).toThrow('not loaded'); expect(() => failed.chat_metadata).toThrow('not loaded');
    });
    test.each(['abort', 'replace'])('discards a delayed complete transcript after session %s', async mode => {
        const controller = new AbortController(); let finish, current = true;
        const read = reader(async () => await new Promise(resolve => { finish = resolve; }), controller.signal, { selection, isCurrent: () => current });
        const pending = read('chat.snapshot', {});
        if (mode === 'abort') controller.abort(); else current = false;
        finish(response()); await expect(pending).rejects.toThrow('replaced or aborted');
    });
});
