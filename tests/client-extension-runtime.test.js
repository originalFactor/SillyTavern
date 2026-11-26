import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, test } from '@jest/globals';

function load(relative, target = ts.ScriptTarget.ES2022) {
    const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target } });
    const exports = {};
    new Function('exports', outputText)(exports);
    return exports;
}
const { installExtensionRuntime } = load('../client/lib/extension-runtime/core.ts');
const { event_types } = load('../client/lib/extension-runtime/events.ts');
const { installExtensionCompatibility } = load('../client/lib/extension-runtime/compatibility.ts');
const { createExtensionResourceReader } = load('../client/lib/extension-runtime/resources.ts');
function compatibility(request = () => { throw Error('Unexpected resource request'); }, overrides = {}) {
    return installExtensionCompatibility(globalThis, { unsupported: name => { throw Error(`Unsupported: ${name}`); }, request, extensionName: 'demo', thirdParty: true, ...overrides });
}
function runtime() {
    const diagnostics = [];
    return { diagnostics, ...installExtensionRuntime({}, {
        unsupported: name => { throw new Error(name); },
        diagnostic: error => diagnostics.push(String(error)), clean: value => value,
    }, event_types, 'zh-CN') };
}

describe('upstream extension runtime semantics', () => {
    test('keeps macro storage inside the serialized installer after compilation to ES2017', () => {
        const compiled = load('../client/lib/extension-runtime/compatibility.ts', ts.ScriptTarget.ES2017).installExtensionCompatibility;
        const isolated = new Function(`return (${compiled.toString()});`)();
        const module = isolated(globalThis, { unsupported: name => { throw Error(name); } })['/scripts/macros.js'];
        module.MacrosParser.registerMacro('serialized', 'value');
        expect(module.MacrosParser.get('serialized')).toBe('value');
        expect([...module.MacrosParser]).toEqual([{ key: 'serialized', description: undefined }]);
    });
    test('retains legacy macro registration order, descriptions, callback identity and frame isolation', () => {
        const { MacrosParser: parser } = compatibility()['/scripts/macros.js'];
        const callback = () => { throw Error('Registration must not evaluate callbacks'); };
        parser.registerMacro(' first ', callback, 'First description');
        parser.registerMacro('second', 42);
        expect(parser.has('first')).toBe(true);
        expect(parser.has(' first ')).toBe(false);
        expect(parser.get('first')).toBe(callback);
        expect(parser.get('second')).toBe('42');
        parser.registerMacro('first', callback);
        expect([...parser]).toEqual([{ key: 'first', description: 'First description' }, { key: 'second', description: undefined }]);
        const env = { keep: 'value', first: 'overwritten' };
        expect(parser.populateEnv(env)).toBeUndefined();
        expect(env).toEqual({ keep: 'value', first: callback, second: '42' });
        expect([...compatibility()['/scripts/macros.js'].MacrosParser]).toEqual([]);
        parser.unregisterMacro(' first ');
        expect(parser.has('first')).toBe(false);
        parser.registerMacro('first', 'new value');
        expect([...parser]).toEqual([{ key: 'second', description: undefined }, { key: 'first', description: undefined }]);
        expect(parser.unregisterMacro('missing')).toBeUndefined();
    });
    test('normalizes legacy macro values without running functions or awaiting promises', () => {
        const { MacrosParser: parser } = compatibility()['/scripts/macros.js'];
        for (const [value, expected] of [[null, ''], [undefined, ''], [Promise.resolve('ignored'), ''], [() => 'ignored', ''], [new Date(0), '1970-01-01T00:00:00.000Z'], [{ a: 1 }, '{"a":1}'], [[1, 2], '[1,2]'], [false, 'false'], [12n, '12']]) expect(parser.sanitizeMacroValue(value)).toBe(expected);
        const circular = {}; circular.self = circular;
        expect(() => parser.sanitizeMacroValue(circular)).toThrow();
        expect(() => parser.sanitizeMacroValue(new Date(NaN))).toThrow();
        parser.registerMacro('object', { a: 1 });
        expect(parser.get('object')).toBe('{"a":1}');
        for (const env of [null, undefined, '', 5]) expect(parser.populateEnv(env)).toBeUndefined();
    });
    test('validates macro keys before changing the registry and preserves case-sensitive names', () => {
        const { MacrosParser: parser } = compatibility()['/scripts/macros.js'];
        for (const key of [null, 2, '', '  ', '{{name', 'name}}']) expect(() => parser.registerMacro(key, 'value')).toThrow('Macro key');
        for (const key of [null, 2, '', '  ']) expect(() => parser.unregisterMacro(key)).toThrow('Macro key');
        expect([...parser]).toEqual([]);
        parser.registerMacro('Name', 'upper'); parser.registerMacro('name', 'lower');
        expect(parser.get('Name')).toBe('upper'); expect(parser.get('name')).toBe('lower');
    });
    test('returns no last message in the settings frame and refuses unbound chat evaluation', () => {
        const macros = compatibility()['/scripts/macros.js'];
        const filter = () => { throw Error('No message should be evaluated'); };
        expect(macros.getLastMessageId()).toBeNull();
        expect(macros.getLastMessageId({ filter })).toBeNull();
        for (const context of [{ characterId: 0 }, { groupId: 'group' }, { chat: [] }]) expect(() => compatibility(undefined, { getContext: () => context })['/scripts/macros.js'].getLastMessageId()).toThrow('complete chat snapshot');
        expect(() => macros.evaluateMacros('hello')).toThrow('not bound');
        expect(() => macros.initMacros()).toThrow('builtin registry');
    });
    test('finds the last full-snapshot message with upstream swipe filtering and zero-based chat indexes', () => {
        const chat = [{ mes: 'first', is_user: true }, { mes: 'last finished', is_user: false }, { mes: 'swiping', swipes: ['old'], swipe_id: 1 }];
        const macros = compatibility(undefined, { getChatSnapshot: () => ({ chat }) })['/scripts/macros.js'];
        expect(macros.getLastMessageId()).toBe(1);
        expect(macros.getLastMessageId({ exclude_swipe_in_propress: false })).toBe(2);
        expect(macros.getLastMessageId({ filter: row => row.is_user })).toBe(0);
        expect(macros.getLastMessageId({ filter: () => false })).toBeNull();
        expect(() => macros.getLastMessageId({ filter() { throw Error('Filter failed'); } })).toThrow('Filter failed');
        expect(compatibility(undefined, { getChatSnapshot: () => ({ chat: [] }) })['/scripts/macros.js'].getLastMessageId()).toBeNull();
    });
    test.each([
        [false, false, true, 'default-user'],
        [false, true, true, 'default-user'],
        [true, false, false, 'reader'],
        [true, true, true, 'reader'],
    ])('initializes upstream account semantics from authenticated identity (%s, %s)', async (accountsEnabled, admin, expectedAdmin, handle) => {
        const calls = [];
        const module = compatibility(async (...args) => { calls.push(args); return { handle: 'reader', accountsEnabled, admin }; })['/scripts/user.js'];
        expect(() => module.isAdmin()).toThrow('not loaded');
        expect(() => module.getCurrentUserHandle()).toThrow('not loaded');
        expect(() => module.accountsEnabled).toThrow('not loaded');
        expect(Object.keys(module)).not.toContain('initialize');
        await module.initialize();
        expect(calls).toEqual([['user.identity', {}]]);
        expect(module.accountsEnabled).toBe(accountsEnabled);
        expect(module.isAdmin()).toBe(expectedAdmin);
        expect(module.getCurrentUserHandle()).toBe(handle);
        await expect(module.setUserControls(false)).rejects.toThrow('server-owned');
        expect(module.accountsEnabled).toBe(accountsEnabled);
    });
    test('does not reuse another frame identity or infer admin when identity loading fails', async () => {
        const admin = compatibility(async () => ({ handle: 'admin', accountsEnabled: true, admin: true }))['/scripts/user.js'];
        await admin.initialize();
        const failed = compatibility(async () => { throw Error('Session unavailable'); })['/scripts/user.js'];
        await expect(failed.initialize()).rejects.toThrow('Session unavailable');
        expect(() => failed.isAdmin()).toThrow('not loaded');
        expect(admin.isAdmin()).toBe(true);
    });
    test('preserves duplicate listeners, callback receiver and snapshot ordering during removal', async () => {
        const { eventSource } = runtime();
        const seen = [];
        function second() { expect(this).toBe(eventSource); seen.push('second'); }
        eventSource.on('event', second);
        eventSource.on('event', second);
        eventSource.makeFirst('event', () => { seen.push('first'); eventSource.removeListener('event', second); });
        await eventSource.emit('event');
        expect(seen).toEqual(['first', 'second', 'second']);
        seen.length = 0;
        await eventSource.emit('event');
        expect(seen).toEqual(['first', 'second']);
    });
    test('awaits listeners sequentially, reports failures and continues with once listeners', async () => {
        const { eventSource, diagnostics } = runtime();
        const seen = [];
        eventSource.on('event', async () => { await Promise.resolve(); seen.push(1); });
        eventSource.on('event', () => { throw Error('listener failed'); });
        eventSource.once('event', value => seen.push(value));
        await eventSource.emit('event', 2);
        await eventSource.emit('event', 3);
        expect(seen).toEqual([1, 2, 1]);
        expect(diagnostics).toEqual(['Error: listener failed', 'Error: listener failed']);
    });
    test('replays ready arguments only for the upstream sticky lifecycle events', async () => {
        const { eventSource } = runtime();
        await eventSource.emit(event_types.APP_READY, 'ready');
        await eventSource.emit(event_types.CHAT_CHANGED, 'chat');
        const seen = [];
        eventSource.on(event_types.APP_READY, value => seen.push(value));
        eventSource.on(event_types.CHAT_CHANGED, value => seen.push(value));
        expect(seen).toEqual(['ready']);
        expect(event_types.CHAT_CHANGED).toBe('chat_id_changed');
        expect(event_types.CHARACTER_DELETED).toBe('characterDeleted');
    });
    test('uses upstream locale casing, indexed template placeholders and first translation wins', () => {
        const { i18n } = runtime();
        expect(i18n.getCurrentLocale()).toBe('zh-cn');
        i18n.addLocaleData('en-us', { 'Hello ${0}': 'Wrong ${0}' });
        expect(i18n.t`Hello ${'Ada'}`).toBe('Hello Ada');
        i18n.addLocaleData('zh-cn', { 'Hello ${0}': '你好 ${0}' });
        i18n.addLocaleData('zh-cn', { 'Hello ${0}': 'Override ${0}' });
        expect(i18n.t`Hello ${'Ada'}`).toBe('你好 Ada');
        expect(i18n.translate('Untranslated')).toBe('Untranslated');
    });
    test('retains upstream hashes and boolean vocabulary rather than broad coercion', () => {
        const { utils } = runtime();
        expect(utils.getStringHash('hello')).toBe(4625896200565286);
        expect(utils.getStringHash(null)).toBe(0);
        expect(utils.isTrueBoolean(' ON ')).toBe(true);
        expect(utils.isTrueBoolean('yes')).toBe(false);
        expect(utils.isFalseBoolean(' OFF ')).toBe(true);
        expect(utils.escapeHtml(null)).toBe('');
        expect(utils.escapeRegex('[a].*')).toBe('\\[a\\]\\.\\*');
    });
    test('waits for conditions and retains the upstream optional timeout resolution', async () => {
        const { utils } = runtime();
        await expect(utils.waitUntilCondition(() => true, 100, 1)).resolves.toBeUndefined();
        await expect(utils.waitUntilCondition(() => false, 1, 100)).rejects.toThrow('Timed out waiting');
        await expect(utils.waitUntilCondition(() => false, 1, 100, { rejectOnTimeout: false })).resolves.toBeInstanceOf(Error);
    });
});

describe('additional upstream modules', () => {
    test('exposes Author note metadata and skips floating prompts only when no chat is bound', () => {
        const note = compatibility()['/scripts/authors-note.js'];
        expect(note.NOTE_MODULE_NAME).toBe('2_floating_prompt');
        expect(note.metadata_keys).toEqual({ prompt: 'note_prompt', interval: 'note_interval', depth: 'note_depth', position: 'note_position', role: 'note_role' });
        expect(note.shouldWIAddPrompt).toBe(false);
        expect(note.setFloatingPrompt()).toBeUndefined();
        expect(note.shouldWIAddPrompt).toBe(false);
        expect(() => note.initAuthorsNote()).toThrow('upstream Author');
        for (const context of [{ characterId: 0 }, { groupId: 'team' }]) {
            expect(() => compatibility(undefined, { getContext: () => context })['/scripts/authors-note.js'].setFloatingPrompt()).toThrow('chat-bound');
        }
    });
    test('shares upstream Persona position enum identity without granting power-user state or generation access', () => {
        const modules = compatibility();
        const power = modules['/scripts/power-user.js'];
        expect(power.persona_description_positions).toBe(modules['/scripts/personas.js'].persona_description_positions);
        expect(power.persona_description_positions).toEqual({ IN_PROMPT: 0, AFTER_CHAR: 1, TOP_AN: 2, BOTTOM_AN: 3, AT_DEPTH: 4, NONE: 9 });
        expect(power.send_on_enter_options).toEqual({ DISABLED: -1, AUTO: 0, ENABLED: 1 });
        expect(power.chat_styles).toEqual({ DEFAULT: 0, BUBBLES: 1, DOCUMENT: 2 });
        expect(power.MAX_CONTEXT_DEFAULT).toBe(8192); expect(power.MAX_RESPONSE_DEFAULT).toBe(2048);
        expect(() => power.power_user.persona_description).toThrow('power_user');
        expect(() => { power.power_user.persona_description = 'change'; }).toThrow('write');
        expect(() => power.addEphemeralStoppingString('stop')).toThrow('generation stopping state');
        expect(() => power.flushEphemeralStoppingStrings()).toThrow('generation stopping state');
    });
    test('retains upstream constant values, global symbol identity and injection/media helper behavior', () => {
        const constants = compatibility()['/scripts/constants.js'];
        expect(constants.debounce_timeout).toEqual({ quick: 100, short: 200, standard: 300, relaxed: 1000, extended: 5000 });
        expect(constants.IGNORE_SYMBOL).toBe(Symbol.for('ignore'));
        expect(constants.GENERATION_TYPE_TRIGGERS).toEqual(['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet']);
        expect(constants.inject_ids.DEPTH_PROMPT_INDEX(2)).toBe('DEPTH_PROMPT_2');
        expect(constants.inject_ids.CUSTOM_WI_DEPTH_ROLE(4, 1)).toBe('customDepthWI_4_1');
        expect(constants.inject_ids.CUSTOM_WI_OUTLET('sample')).toBe('customWIOutlet_sample');
        for (const type of ['image', 'video', 'audio']) expect(constants.MEDIA_TYPE.getFromMime(`${type}/example`)).toBe(type);
        expect(constants.MEDIA_TYPE.getFromMime('application/json')).toBeNull();
        expect(constants.MEDIA_TYPE.getFromMime('IMAGE/png')).toBeNull();
        expect(constants.MEDIA_REQUEST_TYPE).toEqual({ IMAGE: 1, VIDEO: 2, AUDIO: 4 });
        expect(constants.SWIPE_SOURCE.SLASH_COMMAND).toBe('slash_command');
        expect(constants.OVERSWIPE_BEHAVIOR.PRISTINE_GREETING).toBe('pristine_greeting');
        expect(compatibility()['/scripts/constants.js'].MEDIA_SOURCE).not.toBe(constants.MEDIA_SOURCE);
    });
    test('uses upstream Bowser platform classification and caches parsed user agents per frame', async () => {
        for (const [type, expected] of [['mobile', true], ['tablet', true], ['desktop', false], [undefined, false]]) {
            let calls = 0;
            const window = { navigator: { userAgent: 'test agent' }, bowser: { parse: ua => { expect(ua).toBe('test agent'); calls++; return { platform: { type } }; } } };
            const ross = installExtensionCompatibility(window, { unsupported: name => { throw Error(name); } })['/scripts/RossAscends-mods.js'];
            expect(ross.isMobile()).toBe(expected); expect(ross.isMobile()).toBe(expected); expect(calls).toBe(1);
            await expect(ross.favsToHotswap()).rejects.toThrow('character navigation');
        }
        const failed = installExtensionCompatibility({ navigator: { userAgent: '' }, bowser: { parse: () => { throw Error('Empty UA'); } } }, {})['/scripts/RossAscends-mods.js'];
        expect(failed.getParsedUA()).toBeNull(); expect(failed.isMobile()).toBe(false);
    });
    test('formats generation duration, local filenames and ISO message timestamps as upstream does', () => {
        const ross = compatibility()['/scripts/RossAscends-mods.js'];
        expect(ross.humanizeGenTime()).toBe('0 Seconds');
        expect(ross.humanizeGenTime(90061001)).toBe('1 Days, 1 Hours, 1 Minutes, 1 Seconds');
        expect(ross.humanizeGenTime(61000)).toBe('1 Minutes, 1 Seconds');
        const date = new Date(2026, 0, 2, 3, 4, 5, 6);
        expect(ross.humanizedDateTime(date.getTime())).toBe('2026-01-02@03h04m05s006ms');
        expect(ross.getMessageTimeStamp(0)).toBe('1970-01-01T00:00:00.000Z');
        expect(() => ross.getMessageTimeStamp(NaN)).toThrow(RangeError);
    });
    test('reads Persona filenames, updates the selected live export and emits only after a successful selection', async () => {
        const calls = [], published = [], events = [];
        const catalog = { selectedId: 'first.png', username: 'Custom display name', personas: [{ id: 'first.png', name: 'First' }, { id: 'next.png', name: 'Next' }] };
        const module = compatibility(async (op, args) => { calls.push([op, args]); if (op === 'personas.read') return structuredClone(catalog); if (args.id === 'next.png') return { ...catalog, selectedId: args.id, username: 'Next' }; throw Error('Selection failed'); }, {
            publish: (...args) => published.push(args), events: event_types, eventSource: { emit: async (...args) => events.push(args) },
        })['/scripts/personas.js'];
        expect(() => module.user_avatar).toThrow('not loaded');
        expect(() => module.getUserName()).toThrow('not loaded');
        expect(Object.keys(module)).not.toContain('initialize');
        expect(Object.keys(module)).not.toContain('getUserName');
        await module.initialize(); expect(module.user_avatar).toBe('first.png');
        expect(module.getUserName()).toBe('Custom display name');
        await expect(module.getUserAvatars(false)).resolves.toEqual(['first.png', 'next.png']);
        await module.setUserAvatar('next.png', { toastPersonaNameChange: false });
        expect(module.user_avatar).toBe('next.png');
        expect(module.getUserName()).toBe('Next');
        expect(published.slice(-2)).toEqual([['/script.js', 'name1', 'Next'], ['/scripts/personas.js', 'user_avatar', 'next.png']]);
        expect(published.at(-1)).toEqual(['/scripts/personas.js', 'user_avatar', 'next.png']);
        expect(events).toEqual([[event_types.PERSONA_CHANGED, 'next.png']]);
        await module.setUserAvatar('next.png'); expect(calls.filter(([op]) => op === 'personas.select')).toHaveLength(1);
        await expect(module.setUserAvatar('first.png')).rejects.toThrow('Selection failed');
        expect(module.user_avatar).toBe('next.png'); expect(module.getUserName()).toBe('Next'); expect(events).toHaveLength(1);
        const failedCalls = calls.length;
        await module.getUserAvatars(false);
        await expect(module.setUserAvatar('next.png')).rejects.toThrow('Reload');
        expect(calls.filter(([op]) => op === 'personas.select')).toHaveLength(2);
        expect(calls).toHaveLength(failedCalls + 1);
        await expect(module.getUserAvatars()).rejects.toThrow('rendering');
        await expect(module.setUserAvatar('unknown.png')).rejects.toThrow('not found');
        await expect(module.setUserAvatar('first.png', { navigateToCurrent: true })).rejects.toThrow('navigateToCurrent');
        expect(() => module.getUserAvatar('next.png')).toThrow('media service');
    });
    test('extracts upstream provider reasoning with explicit arguments and respects the loaded thoughts switch', async () => {
        const module = compatibility(async () => ({ mainApi: 'openai', source: 'custom', showThoughts: false, textGenType: '' }))['/scripts/reasoning.js'];
        const data = { choices: [{ message: { reasoning: 'fallback', reasoning_content: 'preferred' } }] };
        expect(() => module.extractReasoningFromData(data)).toThrow('not loaded');
        for (const [source, expected] of [['deepseek', 'preferred'], ['xai', 'preferred'], ['custom', 'preferred'], ['openrouter', 'fallback'], ['openai', '']]) {
            expect(module.extractReasoningFromData(data, { mainApi: 'openai', chatCompletionSource: source, ignoreShowThoughts: true })).toBe(expected);
        }
        const explicit = source => ({ mainApi: 'openai', chatCompletionSource: source, ignoreShowThoughts: true });
        expect(module.extractReasoningFromData({ content: [{ type: 'thinking', thinking: 'first' }, { type: 'text', text: 'hidden' }, { type: 'thinking', thinking: 'second' }] }, explicit('claude'))).toBe('first\n\nsecond');
        expect(module.extractReasoningFromData({ responseContent: { parts: [{ thought: true, text: 'thought' }, { text: 'answer' }] } }, explicit('makersuite'))).toBe('thought');
        expect(module.extractReasoningFromData({ choices: [{ message: { content: [{ thinking: [{ text: '' }, { text: 'step' }] }] } }] }, explicit('mistralai'))).toBe('step');
        expect(module.extractReasoningFromData({ thinking: 'ollama thought' }, { mainApi: 'textgenerationwebui', textGenType: 'ollama' })).toBe('ollama thought');
        expect(module.extractReasoningFromData({}, explicit('custom'))).toBe('');
        await module.initialize();
        expect(module.extractReasoningFromData(data)).toBe('');
        expect(module.getMainApi()).toBe('openai');
        expect(Object.keys(module)).not.toContain('getMainApi');
        expect(module.extractReasoningFromData(data, { ignoreShowThoughts: true })).toBe('preferred');
        const enabled = compatibility(async () => ({ mainApi: 'openai', source: 'openrouter', showThoughts: true }))['/scripts/reasoning.js'];
        await enabled.initialize(); expect(enabled.extractReasoningFromData(data)).toBe('fallback');
    });
    test('estimates tokens from UTF-16 string length with matching sync/async counts and optional padding', async () => {
        const { guesstimate, getTokenCount, getTokenCountAsync, CHARACTERS_PER_TOKEN_RATIO, BYTES_PER_TOKEN } = compatibility()['/scripts/tokenizers.js'];
        expect(CHARACTERS_PER_TOKEN_RATIO).toBe(3.35); expect(BYTES_PER_TOKEN).toBe(CHARACTERS_PER_TOKEN_RATIO);
        for (const [text, expected] of [['', 0], ['a', 1], ['abc', 1], ['abcd', 2], ['abcdefghij', 3], ['你好世界', 2], ['😀😀', 2], [' '.repeat(67), 20], [null, 0], [undefined, 0], [42, 0]]) {
            expect(guesstimate(text)).toBe(expected);
            expect(getTokenCount(text)).toBe(expected);
            await expect(getTokenCountAsync(text)).resolves.toBe(expected);
        }
        expect(getTokenCount('abcd', 5)).toBe(7);
        await expect(getTokenCountAsync('你好世界', 5)).resolves.toBe(7);
        expect(getTokenCount('', 5)).toBe(0);
        await expect(getTokenCountAsync(null, 5)).resolves.toBe(0);
        for (const padding of [NaN, Infinity, '5', null]) {
            expect(() => getTokenCount('text', padding)).toThrow('finite number');
            await expect(getTokenCountAsync('text', padding)).rejects.toThrow('finite number');
        }
    });
    test('Prompt collections enforce class identity, preserve defaults and record positional overrides', () => {
        const { Prompt, PromptCollection, INJECTION_POSITION } = compatibility()['/scripts/PromptManager.js'];
        const p = new Prompt({ identifier: 'main', role: 'system', content: 'Hello' });
        expect(p.injection_order).toBe(100); expect(p.injection_trigger).toEqual([]); expect(p.extension).toBe(false);
        const collection = new PromptCollection(p);
        expect(collection.get('main')).toBe(p); expect(collection.index('missing')).toBe(-1); expect(collection.has('main')).toBe(true);
        const replacement = new Prompt({ identifier: 'replacement', injection_order: 0, extension: true });
        collection.override(replacement, 0);
        expect(collection.collection).toEqual([replacement]); expect(collection.overriddenPrompts).toEqual(['replacement']);
        expect(() => collection.add({ identifier: 'fake' })).toThrow('Only Prompt instances');
        expect(INJECTION_POSITION).toEqual({ RELATIVE: 0, ABSOLUTE: 1 });
    });
    test('normalizes slash argument properties, enum identities and upstream boolean suggestions', () => {
        const modules = compatibility();
        const { SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = modules['/scripts/slash-commands/SlashCommandArgument.js'];
        const { SlashCommandEnumValue } = modules['/scripts/slash-commands/SlashCommandEnumValue.js'];
        const { commonEnumProviders, enumIcons, commonEnumMatchProviders } = modules['/scripts/slash-commands/SlashCommandCommonEnumsProvider.js'];
        const boolean = SlashCommandArgument.fromProps({ description: 'Enabled', typeList: ARGUMENT_TYPE.BOOLEAN });
        expect(boolean.typeList).toEqual(['bool']); expect(boolean.enumList.map(String)).toEqual(['true', 'false']);
        expect(boolean.defaultValue).toBeNull(); expect(boolean.isRequired).toBe(false);
        const choice = new SlashCommandEnumValue('one', 'First');
        const named = SlashCommandNamedArgument.fromProps({ name: 'mode', aliasList: 'm', enumList: [choice, 'two'], defaultValue: false });
        expect(named).toBeInstanceOf(SlashCommandArgument); expect(named.enumList[0]).toBe(choice); expect(named.enumList.map(String)).toEqual(['one', 'two']);
        expect(named.aliasList).toEqual(['m']); expect(named.defaultValue).toBe(false); expect(named.typeList).toEqual(['string']);
        expect(commonEnumProviders.boolean('onOffToggle')().map(String)).toEqual(['on', 'off', 'toggle']);
        expect(() => commonEnumProviders.boolean('unknown')()).toThrow('Invalid boolean');
        expect(enumIcons.getWiStatusIcon({ constant: true, disable: true })).toBe(enumIcons.constant);
        expect(commonEnumMatchProviders.folderEnum('Folder', 'folder/child')).toBe(true);
        expect(() => commonEnumProviders.characters()()).toThrow('Unsupported');
    });
    test('registers slash aliases per frame and rejects reserved names without claiming execution support', () => {
        const modules = compatibility();
        const { SlashCommand } = modules['/scripts/slash-commands/SlashCommand.js'];
        const { SlashCommandParser } = modules['/scripts/slash-commands/SlashCommandParser.js'];
        const cmd = SlashCommand.fromProps({ name: 'demo', aliases: ['d'], callback: () => 'result' });
        SlashCommandParser.addCommandObject(cmd);
        expect(new SlashCommandParser().commands.d).toBe(cmd); expect(SlashCommandParser.commands.demo).toBe(cmd);
        expect(cmd.isThirdParty).toBe(true); expect(cmd.source).toBe('demo');
        expect(() => SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: '#bad' }))).toThrow('Illegal Name');
        expect(() => SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'valid', aliases: ['parser-flag-bad'] }))).toThrow('Illegal Name');
        expect(Object.keys(compatibility()['/scripts/slash-commands/SlashCommandParser.js'].SlashCommandParser.commands)).toEqual([]);
        expect(() => new SlashCommandParser().parse('/demo')).toThrow('STscript execution');
        expect(() => modules['/scripts/slash-commands.js'].executeSlashCommandsWithOptions('/demo')).toThrow('STscript execution');
    });
    test('decodes byte-split SSE, multiline payloads, persistent IDs and terminal data without inventing EOF events', async () => {
        const Stream = compatibility()['/scripts/sse-stream.js'].default;
        const source = ': comment\r\nid: first\r\nevent: delta\r\ndata: 你\r\ndata: 好\r\n\r\nid: ignored\0id\ndata: next\n\ndata: [DONE]\n\ndata: unfinished';
        const bytes = new TextEncoder().encode(source);
        const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
        const reader = stream.pipeThrough(new Stream()).getReader(); const events = [];
        for (;;) { const item = await reader.read(); if (item.done) break; events.push({ type: item.value.type, data: item.value.data, id: item.value.lastEventId }); }
        expect(events).toEqual([{ type: 'delta', data: '你\n好', id: 'first' }, { type: 'message', data: 'next', id: 'first' }, { type: 'message', data: '[DONE]', id: 'first' }]);
    });
    test('loads native World Info through a named parent request and parses delimited regex with upstream validation', async () => {
        const calls = [];
        const wi = compatibility(async (...args) => { calls.push(args); return { entries: {} }; })['/scripts/world-info.js'];
        expect(await wi.loadWorldInfo('Forest')).toEqual({ entries: {} }); expect(await wi.loadWorldInfo('')).toBeUndefined();
        expect(calls).toEqual([['worldInfo.load', { name: 'Forest' }]]);
        expect(wi.parseRegexFromString('/a\\/b/i').test('A/b')).toBe(true);
        for (const regex of ['plain', '/a/b/', '/[/', '/a/gg', '//']) expect(wi.parseRegexFromString(regex)).toBeNull();
    });
});

describe('parent-only extension resources', () => {
    const catalog = { selectedId: 'first.png', username: 'Custom display name', revision: 'rev-1', personas: [{ id: 'first.png', name: 'First', description: 'Not forwarded', unexpected: 'private' }, { id: 'next.png', name: 'Next' }] };
    test('retains Persona revisions in the parent and advances them only on checked server responses', async () => {
        const calls = []; const signal = new AbortController().signal;
        const read = createExtensionResourceReader(async (...args) => {
            calls.push(args);
            if (args[0] === '/personas') return catalog;
            return { ...catalog, selectedId: 'next.png', revision: 'rev-2' };
        }, signal, { allowPersonaSelection: true });
        const visible = await read('personas.read', {});
        expect(visible).toEqual({ selectedId: 'first.png', username: 'Custom display name', personas: [{ id: 'first.png', name: 'First' }, { id: 'next.png', name: 'Next' }] });
        expect((await read('personas.select', { id: 'next.png' })).selectedId).toBe('next.png');
        expect(calls[1]).toEqual(['/personas/next.png/select', { method: 'POST', body: JSON.stringify({ expectedRevision: 'rev-1' }), signal }]);
        await read('personas.select', { id: 'first.png' });
        expect(JSON.parse(calls[2][1].body).expectedRevision).toBe('rev-2');
    });
    test('rejects missing, invalid and oversized Persona names without authorizing selection or advancing a revision', async () => {
        for (const username of [undefined, null, {}, 1, 'x'.repeat(65_537)]) {
            let calls = 0;
            const read = createExtensionResourceReader(async () => { calls++; return { ...catalog, username }; }, undefined, { allowPersonaSelection: true });
            await expect(read('personas.read', {})).rejects.toThrow('Invalid Persona catalog');
            await expect(read('personas.select', { id: 'next.png' })).rejects.toThrow('Reload');
            expect(calls).toBe(1);
        }
        const read = createExtensionResourceReader(async () => ({ ...catalog, username: '' }));
        expect((await read('personas.read', {})).username).toBe('');
    });
    test('does not publish a failed Persona selection name or retry it after an invalid reply', async () => {
        const published = [], events = []; let writes = 0;
        const read = createExtensionResourceReader(async path => {
            if (path === '/personas') return catalog;
            writes++;
            return { ...catalog, revision: 'rev-2', selectedId: 'next.png', username: null };
        }, undefined, { allowPersonaSelection: true });
        const module = compatibility(read, { publish: (...args) => published.push(args), events: event_types, eventSource: { emit: async (...args) => events.push(args) } })['/scripts/personas.js'];
        await module.initialize();
        const before = structuredClone(published);
        await expect(module.setUserAvatar('next.png')).rejects.toThrow('Invalid Persona catalog');
        expect(module.getUserName()).toBe('Custom display name'); expect(module.user_avatar).toBe('first.png');
        expect(published).toEqual(before); expect(events).toEqual([]);
        await expect(module.setUserAvatar('next.png')).rejects.toThrow('Reload'); expect(writes).toBe(1);
    });
    test('rejects uninspected/read-only/stale sessions and permanently stops failed Persona mutations without retry', async () => {
        let calls = 0;
        const api = async () => { calls++; if (calls === 1) return catalog; throw Error('Revision conflict'); };
        const read = createExtensionResourceReader(api, undefined, { allowPersonaSelection: true });
        await expect(read('personas.select', { id: 'next.png' })).rejects.toThrow('Reload'); expect(calls).toBe(0);
        await read('personas.read', {});
        await expect(read('personas.select', { id: '../next.png' })).rejects.toThrow('Invalid');
        await expect(read('personas.select', { id: 'next.png', expectedRevision: 'forged' })).rejects.toThrow('Invalid');
        await expect(read('personas.select', { id: 'uninspected.png' })).rejects.toThrow('inspected catalog');
        await expect(read('personas.select', { id: 'next.png' })).rejects.toThrow('Revision conflict');
        await expect(read('personas.select', { id: 'next.png' })).rejects.toThrow('Reload'); expect(calls).toBe(2);
        await expect(createExtensionResourceReader(api)('personas.select', { id: 'next.png' })).rejects.toThrow('read-only');
        await expect(createExtensionResourceReader(api, undefined, { allowPersonaSelection: true, isCurrent: () => false })('personas.read', {})).rejects.toThrow('replaced'); expect(calls).toBe(2);
    });
    test('blocks concurrent Persona selections and reads until the in-flight selection settles', async () => {
        let finish; let calls = 0;
        const read = createExtensionResourceReader(async () => { calls++; return calls === 1 ? catalog : new Promise(resolve => { finish = resolve; }); }, undefined, { allowPersonaSelection: true });
        await read('personas.read', {});
        const selected = read('personas.select', { id: 'next.png' });
        await expect(read('personas.select', { id: 'first.png' })).rejects.toThrow('Reload');
        await expect(read('personas.read', {})).rejects.toThrow('pending');
        finish({ ...catalog, revision: 'rev-2', selectedId: 'next.png' });
        await selected; expect(calls).toBe(2);
    });
    test.each(['personas.read', 'reasoning.settings', 'openai.settings', 'script.cleanupSettings', 'user.identity', 'personas.select', 'chat.printMessages'])('discards %s replies after abort or session replacement', async operation => {
        for (const mode of ['abort', 'replace']) {
            const controller = new AbortController(); let current = true, finish, calls = 0;
            const read = createExtensionResourceReader(async () => {
                calls++;
                if (operation === 'personas.select' && calls === 1) return catalog;
                return new Promise(resolve => { finish = resolve; });
            }, controller.signal, { allowPersonaSelection: true, isCurrent: () => current, printMessages: () => new Promise(resolve => { finish = resolve; }) });
            if (operation === 'personas.select') await read('personas.read', {});
            const pending = read(operation, operation === 'personas.select' ? { id: 'next.png' } : {});
            if (mode === 'abort') controller.abort(); else current = false;
            // Even an otherwise invalid response must be discarded before it
            // can validate, expose data or advance the retained Persona revision.
            finish(null);
            await expect(pending).rejects.toThrow('replaced or aborted');
            const before = calls;
            await expect(read(operation, {})).rejects.toThrow('replaced or aborted');
            expect(calls).toBe(before);
            if (operation === 'personas.select' && mode === 'replace') {
                current = true;
                await expect(read('personas.select', { id: 'next.png' })).rejects.toThrow('Reload');
                expect(calls).toBe(before);
            }
        }
    });
    test('only changes send controls in a bound, current extension session with an exact boolean argument', async () => {
        const controller = new AbortController(), calls = [];
        let current = true;
        const api = async () => { throw Error('No API requests are allowed'); };
        const options = { isCurrent: () => current, setSendButtonsEnabled: (...args) => calls.push(args) };
        const read = createExtensionResourceReader(api, controller.signal, options);
        await expect(createExtensionResourceReader(api)('chat.setSendButtonsEnabled', { enabled: false })).rejects.toThrow('selected conversation');
        await expect(createExtensionResourceReader(api, undefined, options)('chat.setSendButtonsEnabled', { enabled: false })).rejects.toThrow('selected conversation');
        for (const args of [null, [], {}, { enabled: 0 }, { enabled: 'true' }, { enabled: false, chatId: 'other' }, { enabled: true, path: '/generations' }]) await expect(read('chat.setSendButtonsEnabled', args)).rejects.toThrow('Invalid');
        expect(calls).toEqual([]);
        for (const enabled of [false, true]) expect(await read('chat.setSendButtonsEnabled', { enabled })).toBeNull();
        expect(calls).toEqual([[false, controller.signal], [true, controller.signal]]);
        current = false;
        await expect(read('chat.setSendButtonsEnabled', { enabled: false })).rejects.toThrow();
        current = true; controller.abort();
        await expect(read('chat.setSendButtonsEnabled', { enabled: false })).rejects.toThrow();
        expect(calls).toHaveLength(2);
        const failed = createExtensionResourceReader(api, new AbortController().signal, { setSendButtonsEnabled() { throw Error('controls unavailable'); } });
        await expect(failed('chat.setSendButtonsEnabled', { enabled: false })).rejects.toThrow('controls unavailable');
    });
    test('only redraws an explicitly bound conversation and returns completion alone', async () => {
        const signal = new AbortController().signal; const calls = [];
        const api = async () => { throw Error('No arbitrary API calls are allowed'); };
        const standalone = createExtensionResourceReader(api);
        await expect(standalone('chat.printMessages', {})).rejects.toThrow('selected conversation');
        const read = createExtensionResourceReader(api, signal, { printMessages: async bound => { calls.push(bound); return { private: 'transcript' }; } });
        for (const args of [undefined, null, [], { chatId: 'different-chat' }, { path: '/chats/other' }, { method: 'POST' }]) await expect(read('chat.printMessages', args)).rejects.toThrow('Invalid');
        expect(calls).toEqual([]);
        expect(await read('chat.printMessages', {})).toBeNull(); expect(calls).toEqual([signal]);
    });
    test('projects only reasoning scalar switches and never forwards provider credentials or URLs', async () => {
        const calls = [];
        const read = createExtensionResourceReader(async (...args) => { calls.push(args); return { typed: { main_api: 'openai', oai_settings: { chat_completion_source: 'custom', show_thoughts: true, api_key: 'hidden', custom_url: 'https://private.invalid', custom_include_headers: 'hidden' }, power_user: { secret: 'hidden' } } }; });
        expect(await read('reasoning.settings', {})).toEqual({ mainApi: 'openai', source: 'custom', showThoughts: true, textGenType: '' });
        expect(calls).toEqual([['/settings', { signal: undefined }]]);
        await expect(read('reasoning.settings', { path: '/secrets' })).rejects.toThrow('Invalid');
    });
    test('rejects malformed or oversized reasoning identifiers rather than inventing API state', async () => {
        for (const typed of [{}, { main_api: false }, { main_api: 'x'.repeat(257) }, { main_api: 'openai', oai_settings: { chat_completion_source: {} } }, { main_api: 'openai', textgenerationwebui_settings: { type: 'x'.repeat(257) } }]) {
            await expect(createExtensionResourceReader(async () => ({ typed }))('reasoning.settings', {})).rejects.toThrow('Invalid or oversized');
        }
        expect(await createExtensionResourceReader(async () => ({ typed: { main_api: 'openai' } }))('reasoning.settings', {})).toEqual({ mainApi: 'openai', source: '', showThoughts: false, textGenType: '' });
    });
    test('projects only allowlisted Chat Completion model settings and rejects malformed model identifiers', async () => {
        const calls = []; const signal = new AbortController().signal;
        let oai = { chat_completion_source: 'custom', custom_model: 'test-model', openai_model: 'gpt-test', show_thoughts: true, api_key: 'hidden', custom_url: 'https://private.invalid', custom_include_headers: 'secret', reverse_proxy: 'hidden', proxy_password: 'hidden', extensions: { private: 'hidden' }, prompts: [{ content: 'hidden' }] };
        const read = createExtensionResourceReader(async (...args) => { calls.push(args); return { typed: { oai_settings: oai, username: 'not-forwarded' } }; }, signal);
        expect(await read('openai.settings', {})).toEqual({ chat_completion_source: 'custom', custom_model: 'test-model', openai_model: 'gpt-test', show_thoughts: true });
        expect(calls).toEqual([['/settings', { signal }]]);
        await expect(read('openai.settings', { path: '/secrets' })).rejects.toThrow('Invalid'); expect(calls).toHaveLength(1);
        for (const invalid of [{ ...oai, custom_model: {} }, { ...oai, custom_model: 'x'.repeat(8193) }, { ...oai, chat_completion_source: false }, null]) {
            oai = invalid;
            await expect(read('openai.settings', {})).rejects.toThrow('Invalid');
        }
    });
    test('projects only numeric configured token limits and rejects corrupt limits without coercion', async () => {
        let oai = { chat_completion_source: 'custom', openai_max_context: 32768, openai_max_tokens: 1024, api_key: 'private', context_secret: 'private' };
        const read = createExtensionResourceReader(async () => ({ typed: { oai_settings: oai, max_context: 1, amount_gen: 1 } }));
        expect(await read('openai.settings', {})).toEqual({ chat_completion_source: 'custom', show_thoughts: false, openai_max_context: 32768, openai_max_tokens: 1024 });
        oai = { chat_completion_source: 'custom', openai_max_context: 1, openai_max_tokens: 0 };
        expect(await read('openai.settings', {})).toMatchObject({ openai_max_context: 1, openai_max_tokens: 0 });
        // Context minus response may be negative in upstream queries; reading
        // these settings neither validates nor dispatches a generation request.
        oai = { chat_completion_source: 'custom', openai_max_context: 1, openai_max_tokens: Number.MAX_SAFE_INTEGER };
        expect((await read('openai.settings', {})).openai_max_tokens).toBe(Number.MAX_SAFE_INTEGER);
        for (const key of ['openai_max_context', 'openai_max_tokens']) {
            for (const value of ['8192', null, {}, [], true, NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, ...(key === 'openai_max_context' ? [0] : [])]) {
                oai = { chat_completion_source: 'custom', [key]: value };
                await expect(read('openai.settings', {})).rejects.toThrow('Invalid Chat Completion token limit');
            }
        }
        oai = { chat_completion_source: 'custom' };
        const missing = await read('openai.settings', {});
        expect(Object.hasOwn(missing, 'openai_max_context')).toBe(false);
        expect(Object.hasOwn(missing, 'openai_max_tokens')).toBe(false);
    });
    test('projects authenticated identity alone and rejects forged or incomplete session documents', async () => {
        const calls = []; const signal = new AbortController().signal;
        const identity = { authenticated: true, handle: 'reader', accountsEnabled: true, admin: false };
        let response = { ...identity, csrfTokenUrl: '/csrf-token', token: 'private', profile: { secret: 'private' } };
        const read = createExtensionResourceReader(async (...args) => { calls.push(args); return response; }, signal);
        expect(await read('user.identity', {})).toEqual({ handle: 'reader', accountsEnabled: true, admin: false });
        expect(calls).toEqual([['/session', { signal }]]);
        await expect(read('user.identity', { admin: true })).rejects.toThrow('Invalid');
        expect(calls).toHaveLength(1);
        for (const invalid of [{ ...identity, authenticated: false }, { ...identity, admin: 'true' }, { ...identity, accountsEnabled: undefined }, { ...identity, handle: '../other' }, null]) {
            response = invalid;
            await expect(read('user.identity', {})).rejects.toThrow('Invalid authenticated identity');
        }
    });
    test('projects and caches only the cleanup switches and prompt-bias presence', async () => {
        let calls = 0;
        const signal = new AbortController().signal;
        const power = { collapse_newlines: true, trim_sentences: false, auto_fix_generated_markdown: true, allow_name1_display: true, allow_name2_display: false, trim_spaces: true, user_prompt_bias: '', api_key: 'hidden', reasoning: { prefix: 'private' }, username: 'not-bound', instruct: { enabled: true } };
        const read = createExtensionResourceReader(async (path, init) => {
            calls++; expect(path).toBe('/settings'); expect(init).toEqual({ signal });
            return { typed: { main_api: 'openai', power_user: power, oai_settings: { api_key: 'hidden', custom_url: 'https://private.invalid' } } };
        }, signal);
        const expected = { mainApi: 'openai', hasUserPromptBias: false, ...Object.fromEntries(Object.entries(power).filter(([key]) => ['collapse_newlines', 'trim_sentences', 'auto_fix_generated_markdown', 'allow_name1_display', 'allow_name2_display', 'trim_spaces'].includes(key))) };
        expect(await read('script.cleanupSettings', {})).toEqual(expected);
        expect(await read('script.cleanupSettings', {})).toEqual(expected);
        expect(calls).toBe(1);
        expect(await createExtensionResourceReader(async () => ({ typed: { main_api: 'openai' } }))('script.cleanupSettings', {})).toEqual({ mainApi: 'openai' });
    });
    test('rejects invalid cleanup arguments, scalar types and oversized UTF-8 values without retrying', async () => {
        let calls = 0;
        const read = createExtensionResourceReader(async () => { calls++; throw Error('unavailable'); });
        for (const args of [null, [], { path: '/settings' }, { method: 'GET' }]) await expect(read('script.cleanupSettings', args)).rejects.toThrow('Invalid');
        expect(calls).toBe(0);
        await expect(read('script.cleanupSettings', {})).rejects.toThrow('unavailable');
        await expect(read('script.cleanupSettings', {})).rejects.toThrow('unavailable');
        expect(calls).toBe(1);
        for (const typed of [{}, { main_api: 1 }, { main_api: 'x'.repeat(257) }, { main_api: 'openai', power_user: [] }, { main_api: 'openai', power_user: { trim_spaces: 1 } }, { main_api: 'openai', power_user: { user_prompt_bias: null } }, { main_api: 'openai', power_user: { user_prompt_bias: '你'.repeat(21846) } }]) {
            await expect(createExtensionResourceReader(async () => ({ typed }))('script.cleanupSettings', {})).rejects.toThrow(/Invalid|oversized/);
        }
        expect(await createExtensionResourceReader(async () => ({ typed: { main_api: 'openai', power_user: { user_prompt_bias: 'x'.repeat(65536) } } }))('script.cleanupSettings', {})).toEqual({ mainApi: 'openai', hasUserPromptBias: true });
    });
    test('projects only the bounded example separator and preserves missing fields without defaults', async () => {
        for (const separator of ['', '---', '{{user}}', '你'.repeat(21845) + 'x']) {
            const read = createExtensionResourceReader(async () => ({ typed: { main_api: 'openai', power_user: { context: { example_separator: separator, story_string: 'private prompt', api_key: 'hidden', unknown: { private: true } } } } }));
            expect(await read('script.cleanupSettings', {})).toEqual({ mainApi: 'openai', exampleSeparator: separator });
        }
        expect(await createExtensionResourceReader(async () => ({ typed: { main_api: 'openai', power_user: { context: {} } } }))('script.cleanupSettings', {})).toEqual({ mainApi: 'openai' });
        for (const context of [null, [], 'context', false, { example_separator: null }, { example_separator: 42 }, { example_separator: '你'.repeat(21846) }]) {
            let calls = 0;
            const read = createExtensionResourceReader(async () => { calls++; return { typed: { main_api: 'openai', power_user: { context } } }; });
            await expect(read('script.cleanupSettings', {})).rejects.toThrow(/Invalid|oversized/);
            await expect(read('script.cleanupSettings', {})).rejects.toThrow(/Invalid|oversized/);
            expect(calls).toBe(1);
        }
    });
    test('forwards only the encoded World Info GET with the bound abort signal and returns book data alone', async () => {
        const calls = []; const signal = new AbortController().signal;
        const read = createExtensionResourceReader(async (...args) => { calls.push(args); return { name: 'Forest', revision: 'private-revision', book: { entries: {} } }; }, signal);
        expect(await read('worldInfo.load', { name: 'Forest ? # %' })).toEqual({ entries: {} });
        expect(calls).toEqual([['/world-info/Forest%20%3F%20%23%20%25', { signal }]]);
    });
    test('rejects arbitrary operations, paths and extra request properties before dispatch', async () => {
        let calls = 0; const read = createExtensionResourceReader(async () => { calls++; });
        for (const name of ['', '../settings', 'a/b', 'a\\b', '..', ' name', 'bad\0name', 'x'.repeat(257)]) await expect(read('worldInfo.load', { name })).rejects.toThrow('Invalid');
        await expect(read('fetch', { name: 'Forest' })).rejects.toThrow('Unsupported');
        await expect(read('worldInfo.load', { name: 'Forest', method: 'DELETE' })).rejects.toThrow('Invalid');
        await expect(read('worldInfo.load', null)).rejects.toThrow('Invalid');
        expect(calls).toBe(0);
    });
    test('propagates errors without retries and rejects invalid or oversized book responses', async () => {
        let calls = 0;
        const read = createExtensionResourceReader(async () => { calls++; throw Error('Book not found'); });
        await expect(read('worldInfo.load', { name: 'missing' })).rejects.toThrow('Book not found'); expect(calls).toBe(1);
        await expect(createExtensionResourceReader(async () => ({}))('worldInfo.load', { name: 'bad' })).rejects.toThrow('Invalid');
        await expect(createExtensionResourceReader(async () => ({ book: { value: 'x'.repeat(4_194_304) } }))('worldInfo.load', { name: 'huge' })).rejects.toThrow('4 MiB');
    });
});
