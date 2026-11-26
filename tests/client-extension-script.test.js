import fs from 'node:fs';
import ts from 'typescript';
import sanitize from 'sanitize-filename';
import Handlebars from 'handlebars';
import { describe, expect, jest, test } from '@jest/globals';

function installer(file, name) {
    const source = fs.readFileSync(new URL(`../client/lib/extension-runtime/${file}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } });
    const exports = {}; new Function('exports', outputText)(exports);
    return new Function(`return (${exports[name].toString()});`)();
}
const installCore = installer('core', 'installExtensionRuntime');
const installScript = installer('script', 'installExtensionScript');
const unsupported = name => { throw Error(`Unsupported: ${name}`); };
function runtime(overrides = {}, window = {}) {
    const core = installCore({}, { unsupported, diagnostic: () => {}, clean: value => value }, { GENERATION_STOPPED: 'generation_stopped' }, 'en-US');
    return { ...core, script: installScript(window, { utils: core.utils, eventSource: core.eventSource, events: core.events, unsupported, ...overrides }) };
}

describe('isolated extension utility and script interfaces', () => {
    test('normalizes literal substituteParams inputs and the extended/positional signatures without running callbacks or native macros', () => {
        const { script } = runtime({ request() { throw Error('Unexpected native request'); } });
        const unsafe = new Proxy({}, { get() { throw Error('Literal substitution must not read native macro options'); } });
        const callback = () => { throw Error('No macro replacement must run'); };
        for (const [value, expected] of [[undefined, ''], [null, ''], [false, ''], [0, ''], [NaN, ''], ['', ''], [true, 'true'], [12, '12'], [12n, '12'], [Infinity, 'Infinity'], [['a', 'b'], 'a,b'], ['  Literal\r\n原文  ', '  Literal\r\n原文  '], [{ toString: () => 'custom' }, 'custom']]) {
            expect(script.substituteParams(value, unsafe)).toBe(expected);
            expect(script.substituteParams(value, 'User', 'Character', unsafe)).toBe(expected);
            expect(script.substituteParamsExtended(value, unsafe, callback)).toBe(expected);
        }
        expect(script.substituteParams('<div>literal HTML</div>', { dynamicMacros: unsafe, postProcessFn: callback })).toBe('<div>literal HTML</div>');
        for (const value of ['{{user}}', '{{unknown}}', '{{', '\\{{escaped}}', '<USER>', '<bot>', '<Char>', '<CHARIFNOTGROUP>', '<gRoUp>', { toString: () => '{{var::private}}' }]) {
            expect(() => script.substituteParams(value, { name1Override: 'Explicit', dynamicMacros: unsafe })).toThrow('macro evaluation context is not bound');
            expect(() => script.substituteParamsExtended(value, unsafe, callback)).toThrow('macro evaluation context is not bound');
        }
        const invalid = { toString() { throw Error('String conversion failed'); } };
        expect(() => script.substituteParams(invalid)).toThrow('String conversion failed');
    });
    test('extracts source Handlebars bias helpers including multiple matches, builtins, empty values and parse failures', () => {
        const { script } = runtime({}, { Handlebars });
        for (const [message, expected] of [
            [undefined, ''], [null, ''], [false, ''], [0, ''], ['', ''], ['plain text', ''],
            ['{{bias "first"}} text {{bias "second"}}', ' first second'],
            ['{{bias "a & <b>"}}', ' a & <b>'], ['{{bias ""}}', ' '],
            ['{{bias missing}}', ' '], ['{{#bias "block"}}ignored{{/bias}}', ' block'],
            ['{{#if true}}{{bias "yes"}}{{else}}{{bias "no"}}{{/if}}', ' yes'],
            ['{{bias "before"}}{{unknown "error"}}', ''], ['{{bias "unterminated}}', ''],
            [42, ''], [{ arbitrary: true }, ''],
        ]) expect(script.extractMessageBias(message)).toBe(expected);
        expect(runtime({}, { Handlebars }).script.extractMessageBias('{{bias "isolated"}}')).toBe(' isolated');
        expect(script.extractMessageBias('{{bias "later"}}')).toBe(' later');
    });
    test('returns source bias suppression for continue/impersonate and refuses unbound historical or configured bias', () => {
        const { script } = runtime();
        const unsafe = new Proxy({}, { get() { throw Error('Suppressed bias must not inspect input'); } });
        for (const type of ['continue', 'impersonate', new String('continue')]) expect(script.getBiasStrings(unsafe, type)).toEqual({ messageBias: '', promptBias: '', isUserPromptBias: false });
        for (const type of [undefined, 'normal', 'swipe', 'quiet', 'CONTINUE']) expect(() => script.getBiasStrings('{{bias "explicit"}}', type)).toThrow('prompt-bias settings and macro context are not bound');
    });
    test('notifies only frame-local generation-stopped listeners and returns false without cancelling native work', async () => {
        const { script, eventSource, events } = runtime({ request() { throw Error('No native cancellation is authorized'); } });
        const foreign = runtime(), observed = [], foreignListener = jest.fn();
        foreign.eventSource.on(foreign.events.GENERATION_STOPPED, foreignListener);
        eventSource.on(events.GENERATION_STOPPED, (...args) => observed.push(args));
        expect(script.stopGeneration()).toBe(false); await Promise.resolve();
        expect(observed).toEqual([[]]); expect(foreignListener).not.toHaveBeenCalled();
    });
    test('allows only the source undefined-ID unshallow branch without manufacturing a character catalog', async () => {
        const { script } = runtime({ request() { throw Error('Unexpected catalog request'); } });
        await expect(script.unshallowCharacter()).resolves.toBeUndefined();
        for (const id of [null, 0, '0', '', 'missing']) await expect(script.unshallowCharacter(id)).rejects.toThrow('complete upstream character catalog is not bound');
    });
    test('imports guarded native entry points but fails before inspecting inputs, queuing debounced saves or making requests', async () => {
        jest.useFakeTimers();
        try {
            const { script } = runtime({ request() { throw Error('Unexpected native request'); } });
            const unsafe = new Proxy({}, { get() { throw Error('Guarded input must not be read'); } });
            const synchronous = ['saveCharacterDebounced', 'getThumbnailUrl', 'getCharacterCardFields', 'messageFormatting', 'addOneMessage', 'setExtensionPrompt', 'reloadMarkdownProcessor', 'showSwipeButtons', 'setGenerationProgress', 'setUserName', 'scrollChatToBottom'];
            const asynchronous = ['clearChat', 'reloadCurrentChat', 'deleteCharacter', 'getCharacters', 'getOneCharacter', 'getPastCharacterChats', 'printCharacters', 'selectCharacterById'];
            for (const name of synchronous) expect(() => script[name](unsafe)).toThrow(name);
            for (const name of asynchronous) {
                let result; expect(() => { result = script[name](unsafe); }).not.toThrow();
                expect(result).toBeInstanceOf(Promise); await expect(result).rejects.toThrow(name);
            }
            expect(jest.getTimerCount()).toBe(0);
        } finally { jest.useRealTimers(); }
    });
    test('bridges native send button controls without returning host data or accepting target arguments', async () => {
        const calls = [];
        const { script } = runtime({ request: async (...args) => { calls.push(args); return { private: 'native state' }; } });
        await expect(script.deactivateSendButtons('other-chat')).resolves.toBeUndefined();
        await expect(script.activateSendButtons('other-chat')).resolves.toBeUndefined();
        expect(calls).toEqual([['chat.setSendButtonsEnabled', { enabled: false }], ['chat.setSendButtonsEnabled', { enabled: true }]]);
        const failed = runtime({ request: async () => { throw Error('controls unavailable'); } }).script;
        for (const name of ['activateSendButtons', 'deactivateSendButtons']) await expect(failed[name]()).rejects.toThrow('controls unavailable');
    });
    test('imports chat save entry points but rejects unbound persistence asynchronously without RPC or inspecting supplied snapshots', async () => {
        const { script } = runtime({ request: () => { throw Error('Unexpected resource request'); } });
        const unsafe = new Proxy({}, { get() { throw Error('Chat options must not be read'); } });
        for (const name of ['saveChatConditional', 'saveMetadata', 'saveChat']) {
            let result;
            expect(() => { result = script[name](unsafe); }).not.toThrow();
            expect(result).toBeInstanceOf(Promise);
            await expect(result).rejects.toThrow('mutable chat state and transcript persistence lifecycle are not bound');
        }
        // A no-selection frame also has no authority to claim a successful save.
        await expect(script.saveChatConditional()).rejects.toThrow('saveChatConditional');
        await expect(script.saveMetadata()).rejects.toThrow('saveChatConditional');
        await expect(script.saveChat()).rejects.toThrow('saveChat');
    });
    test('requests a scoped native redraw and waits for completion without leaking its result', async () => {
        const calls = []; let finish;
        const { script } = runtime({ request: (operation, args) => { calls.push([operation, args]); return new Promise(resolve => { finish = resolve; }); } });
        let completed = false;
        const pending = script.printMessages('ignored upstream argument').then(value => { completed = true; return value; });
        expect(completed).toBe(false); expect(calls).toEqual([['chat.printMessages', {}]]);
        finish({ private: 'must not become a result' }); await expect(pending).resolves.toBeUndefined();
        const failed = runtime({ request: async () => { throw Error('no selected conversation'); } }).script;
        await expect(failed.printMessages()).rejects.toThrow('no selected conversation');
    });
    test('forwards card preprocessing and example parsing arguments without losing legacy values', () => {
        const calls = [];
        const result = {};
        const { script } = runtime({ cleanup: Object.fromEntries(['baseChatReplace', 'parseMesExamples'].map(name => [name, (...args) => { calls.push([name, args]); return result; }])) });
        expect(script.baseChatReplace(null, '', 'Character')).toBe(result);
        expect(script.parseMesExamples('<START>', false)).toBe(result);
        expect(calls).toEqual([['baseChatReplace', [null, '', 'Character']], ['parseMesExamples', ['<START>', false]]]);
    });
    test('matches filename sanitization for reserved names, controls, UTF-8 boundaries and scalar conversion', async () => {
        const { utils } = runtime();
        const values = [undefined, null, false, 0, 42, 12n, {}, ['a', 'b'], '.', '..', '...', 'CON', 'prn.txt', 'AUX .txt', 'nul.', 'COM0', 'LPT9.txt', 'com¹.txt', 'lpt²', 'COM³', 'normal.txt', 'a/b\\c:d?e*f|g<h>i"j', 'a\x00b\x7fc\x80d\x9fe', 'foo. . ', 'a'.repeat(254) + '.é', 'a'.repeat(252) + '😀', '你'.repeat(86), '😀'.repeat(65), '\ud800', '\udfff', 'a'.repeat(253) + '\ud800', 'a'.repeat(251) + '😀x', { toString: () => 'custom?.txt' }];
        // Fixed-seed mixtures catch interaction between filtering and UTF-8 truncation.
        const alphabet = ['a', '.', ' ', '/', '?', '\x01', '\x85', '你', '😀', '\ud800', '\udfff', 'C', 'O', 'N', '¹'];
        let seed = 421;
        for (let sample = 0; sample < 512; sample++) {
            let value = '';
            for (let i = 0; i < 280; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; value += alphabet[seed % alphabet.length]; }
            values.push(value);
        }
        for (const value of values) {
            const result = await utils.getSanitizedFilename(value);
            expect(result).toBe(sanitize(String(value)));
            expect(Buffer.byteLength(result)).toBeLessThanOrEqual(255);
        }
        for (const value of ['', [], { toString: () => '' }]) await expect(utils.getSanitizedFilename(value)).rejects.toThrow('filename');
        await expect(utils.getSanitizedFilename({ toString() { throw Error('conversion failed'); } })).rejects.toThrow('conversion failed');
    });
    test('extracts explicit avatar names without guessing a selected native character', () => {
        const { utils } = runtime();
        for (const [avatar, expected] of [['Ada.png', 'Ada'], ['Ada.card.png', 'Ada.card'], ['folder/Ada.png', 'folder/Ada'], ['folder.x/Ada', 'folder.x/Ada'], ['.png', ''], ['Ada.', 'Ada.'], ['', '']]) expect(utils.getCharaFilename(0, { manualAvatarKey: avatar })).toBe(expected);
        for (const id of [null, 0, '0', 'missing']) expect(() => utils.getCharaFilename(id)).toThrow('not bound');
        expect(() => utils.getCharaFilename(null, { manualAvatarKey: 5 })).toThrow(TypeError);
    });
    test('reports unavailable downloads and icon inventories before touching DOM or network', async () => {
        const { utils } = runtime();
        expect(() => utils.download('text', 'file.txt', 'text/plain')).toThrow('sandbox downloads');
        await expect(utils.showFontAwesomePicker()).rejects.toThrow('default icon inventory');
        for (const value of [false, ['fa-user'], [[]], [['bad class']], [['fa-user', 1]], Array(2), [Array(2)], Array(4097).fill(['fa-user']), [Array(33).fill('fa-user')], [['fa-' + 'a'.repeat(128)]]]) await expect(utils.showFontAwesomePicker(value)).rejects.toThrow('Invalid or oversized');
    });
    test('reexports identical utility functions and retains upstream overlapping/empty occurrence behavior', () => {
        const { utils, script } = runtime();
        expect(script.isOdd).toBe(utils.isOdd);
        expect(script.countOccurrences).toBe(utils.countOccurrences);
        for (const [text, part, count] of [['aaaa', 'aa', 3], ['abc', '', 3], ['', '', 0], ['😀😀', '😀', 2], ['Hello, world!', 'l', 3], ['abc', 'abcd', 0]]) expect(script.countOccurrences(text, part)).toBe(count);
        for (const value of [-3, 0, 2, 3, 1.5, NaN, Infinity, '3']) expect(script.isOdd(value)).toBe(value % 2 !== 0);
    });
    test('exposes source constants and case-sensitive prompt role resolution without chat defaults', () => {
        const { script } = runtime();
        expect(script.MAX_INJECTION_DEPTH).toBe(10000);
        expect(script.DEFAULT_SAVE_EDIT_TIMEOUT).toBe(1000); expect(script.DEFAULT_PRINT_TIMEOUT).toBe(100);
        expect(script.extension_prompt_types).toEqual({ NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 });
        expect(script.extension_prompt_roles).toEqual({ SYSTEM: 0, USER: 1, ASSISTANT: 2 });
        expect(script.system_message_types).toMatchObject({ ASSISTANT_MESSAGE: 'assistant_message', NARRATOR: 'narrator', COMMENT: 'comment' });
        expect(script.default_avatar).toBe('img/ai4.png'); expect(script.default_user_avatar).toBe('img/user-default.png');
        for (const [value, role] of [[0, 0], [1, 1], [2, 2], ['system', 0], ['user', 1], ['assistant', 2], ['USER', 0], ['1', 0], [3, 0], [null, 0], [undefined, 0], [{ toString: () => 'user' }, 0]]) expect(script.getExtensionPromptRoleByName(value)).toBe(role);
        expect(Object.keys(script.extension_prompts)).toEqual([]);
        for (const key of ['characters', 'this_chid', 'name2']) expect(() => script[key]).toThrow('snapshot is not loaded');
        for (const key of ['chat', 'chat_metadata']) expect(() => script[key]).toThrow('snapshot is not loaded');
        expect(runtime().script.extension_prompt_roles).not.toBe(script.extension_prompt_roles);
    });
    test('reads live state through the shared adapters without eagerly accessing unloaded state', () => {
        let avatar = 'first.png', username = 'Custom user', api = 'openai', loaded = false;
        const { script } = runtime({
            personas: { get user_avatar() { if (!loaded) throw Error('not loaded'); return avatar; }, getUserName() { if (!loaded) throw Error('not loaded'); return username; } },
            reasoning: { getMainApi() { if (!loaded) throw Error('not loaded'); return api; } },
        });
        expect(Object.keys(script)).toContain('user_avatar');
        expect(() => script.user_avatar).toThrow('not loaded');
        expect(() => script.main_api).toThrow('not loaded');
        expect(() => script.name1).toThrow('not loaded');
        loaded = true;
        expect(script.user_avatar).toBe('first.png'); expect(script.main_api).toBe('openai');
        expect(script.name1).toBe('Custom user');
        avatar = 'next.png'; username = 'Next user'; api = 'custom';
        expect(script.user_avatar).toBe('next.png'); expect(script.main_api).toBe('custom');
        expect(script.name1).toBe('Next user');
        for (const name of ['user_avatar', 'main_api', 'name1', 'name2']) expect(Object.getOwnPropertyDescriptor(script, name)).toMatchObject({ enumerable: true, set: undefined });
    });
    test('matches the upstream no-selection chat ID and rejects unbound future selections', () => {
        const context = {};
        const { script } = runtime({ getContext: () => context });
        expect(script.getCurrentChatId()).toBeUndefined();
        context.characterId = 0;
        expect(() => script.getCurrentChatId()).toThrow('selection is not bound');
        context.characterId = undefined; context.groupId = 'group';
        expect(() => script.getCurrentChatId()).toThrow('selection is not bound');
        context.groupId = null;
        expect(script.getCurrentChatId()).toBeUndefined();
    });
    test('reads configured Chat Completion limits and preserves the deprecated prompt-budget alias', () => {
        const settings = { openai_max_context: 8192, openai_max_tokens: 1024 };
        const { script } = runtime({ reasoning: { getMainApi: () => 'openai' }, openai: { oai_settings: settings } });
        expect(script.getMaxContextTokens()).toBe(8192);
        expect(script.getMaxResponseTokens()).toBe(1024);
        expect(script.getMaxContextSize).toBe(script.getMaxPromptTokens);
        for (const value of [undefined, null, 0, -1, NaN, -Infinity, '512', false, {}, new Number(512)]) expect(script.getMaxPromptTokens(value)).toBe(7168);
        for (const [value, expected] of [[512, 7680], [0.5, 8191.5], [8192, 0], [9000, -808], [Infinity, -Infinity]]) expect(script.getMaxPromptTokens(value)).toBe(expected);
        settings.openai_max_tokens = 0;
        expect(script.getMaxPromptTokens()).toBe(8192);
        settings.openai_max_tokens = 9000;
        expect(script.getMaxPromptTokens()).toBe(-808);
    });
    test('fails on unloaded, unsupported or unavailable token limits without manufacturing defaults', () => {
        const unloaded = runtime({ reasoning: { getMainApi() { throw Error('not loaded'); } } }).script;
        expect(() => unloaded.getMaxContextSize()).toThrow('not loaded');
        const unavailable = runtime({ reasoning: { getMainApi: () => 'openai' }, openai: { oai_settings: { openai_max_context: 8192 } } }).script;
        expect(unavailable.getMaxContextTokens()).toBe(8192);
        expect(unavailable.getMaxPromptTokens(512)).toBe(7680);
        expect(() => unavailable.getMaxResponseTokens()).toThrow('unavailable');
        expect(() => unavailable.getMaxContextSize()).toThrow('unavailable');
        for (const api of ['kobold', 'novel', 'textgenerationwebui', 'unknown', '']) {
            const { script } = runtime({ reasoning: { getMainApi: () => api }, openai: { get oai_settings() { throw Error('must not access OpenAI settings'); } } });
            for (const key of ['getMaxContextTokens', 'getMaxResponseTokens', 'getMaxPromptTokens', 'getMaxContextSize']) expect(() => script[key]()).toThrow('only Chat Completion');
        }
    });
    test('memoizes lazy fields only after success and preserves descriptors and object identity', () => {
        const { script } = runtime();
        let calls = 0, failures = 0;
        const value = ['greeting'];
        const resolvers = Object.fromEntries([['first', () => { calls++; return value; }], ['retry', () => { if (++failures === 1) throw Error('try again'); return undefined; }], ['__proto__', () => 'ordinary field']]);
        const fields = script.createLazyFields(resolvers);
        expect(calls).toBe(0);
        expect(Object.keys(fields)).toEqual(['first', 'retry', '__proto__']);
        expect(fields.first).toBe(value); expect(fields.first).toBe(value); expect(calls).toBe(1);
        expect(() => fields.retry).toThrow('try again'); expect(fields.retry).toBeUndefined(); expect(fields.retry).toBeUndefined(); expect(failures).toBe(2);
        expect(Object.getPrototypeOf(fields)).toBe(Object.prototype); expect(fields.__proto__).toBe('ordinary field');
        expect(Object.getOwnPropertyDescriptor(fields, 'first')).toMatchObject({ enumerable: true, configurable: true, set: undefined });
        Object.defineProperty(fields, 'first', { value: 'replacement' }); expect(fields.first).toBe('replacement');
    });
});


test('generation exports publish live native state without granting mutation, emitting lifecycle events or changing UI locks', () => {
    const published = [], requests = [];
    const { script, eventSource, events } = runtime({ publish: (...args) => published.push(args), request: (...args) => requests.push(args) });
    const stopped = jest.fn(); eventSource.on(events.GENERATION_STOPPED, stopped);
    expect(script.is_send_press).toBe(false); expect(script.isGenerating()).toBe(false);
    expect(Object.keys(script)).not.toContain('updateGenerationState');
    script.updateGenerationState({ isSendPress: true, isGroupGenerating: false });
    expect(script.is_send_press).toBe(true); expect(script.isGenerating()).toBe(true);
    expect(published.at(-1)).toEqual(['/script.js', 'is_send_press', true]);
    script.updateGenerationState({ isSendPress: false, isGroupGenerating: true });
    expect(script.is_send_press).toBe(false); expect(script.isGenerating()).toBe(true);
    for (const value of [null, {}, true, { isSendPress: 1, isGroupGenerating: false }]) expect(() => script.updateGenerationState(value)).toThrow('Invalid native generation state');
    expect(script.isGenerating()).toBe(true);
    script.updateGenerationState({ isSendPress: false, isGroupGenerating: false });
    expect(script.isGenerating()).toBe(false); expect(stopped).not.toHaveBeenCalled(); expect(requests).toEqual([]);
});
