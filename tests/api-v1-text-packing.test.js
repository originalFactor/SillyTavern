import path from 'node:path';
import { beforeAll, describe, expect, test } from '@jest/globals';
import { createMacroContext } from '../src/headless/macros.js';
import { assembleTextPrompt } from '../src/headless/text-runtime/index.js';
import { setConfigFilePath } from '../src/util.js';
import { serverDirectory } from '../src/server-directory.js';
import { buildStringPrompt, buildPrompt } from '../src/headless/prompt.js';
import { configureTextRuntime } from '../src/headless/text-runtime/platform.js';
import { selectLocalTextTokenizer } from '../src/headless/text-runtime/index.js';

beforeAll(() => setConfigFilePath(path.join(serverDirectory, 'default/config.yaml')));
const user = mes => ({ mes, name: 'Reader', is_user: true });
const assistant = mes => ({ mes, name: 'Aria', is_user: false });
function fixture(history = [assistant('Greeting'), user('Latest input')], power = {}, budget = 2048) {
    const chat = [{ chat_metadata: {} }, ...history];
    const session = { userName: 'Reader', directories: {}, extensionSettings: {}, settings: {
        main_api: 'textgenerationwebui', max_context: budget, amount_gen: 64,
        power_user: { sysprompt: { enabled: false }, ...power },
    } };
    const context = createMacroContext(session, { name: 'Aria' }, chat);
    return { context, history, session, chat, run: (fields = {}, examples = [], options = {}) => assembleTextPrompt(context, fields, history, examples, options) };
}
describe('source-derived string context packing', () => {
    test('plain context/story, source names, example order and output head', async () => {
        const f = fixture(undefined, { always_force_name2: true, context: { story_string: 'Bio: {{description}}', chat_start: 'CHAT' } });
        const built = await f.run({ description: 'Pilot' }, ['EXAMPLE\n']);
        expect(built.prompt).toBe('Bio: Pilot\nEXAMPLE\nCHAT\nAria: Greeting\nReader: Latest input\nAria:');
        expect(built.tokenBudget.remainingTokens).toBeGreaterThan(0);
    });
    test('first/last Instruct sequences and true output head survive packing', async () => {
        const f = fixture(undefined, { instruct: { enabled: true, names_behavior: 'none', first_output_sequence: '[FIRST]', last_input_sequence: '[LAST]', output_sequence: '[OUT]' }, context: { chat_start: '' } });
        const built = await f.run({}, [], { requireNewestUser: true });
        expect(built.prompt).toContain('[FIRST]\nGreeting');
        expect(built.prompt).toContain('[LAST]\nLatest input');
        expect(built.prompt.endsWith('[OUT]\n')).toBe(true);
    });
    test('source context fitter keeps newest contiguous history with token-based clipping', async () => {
        const rows = Array.from({ length: 100 }, (_, i) => i % 2 ? user(`row${i} ${'word '.repeat(12)}`) : assistant(`row${i} ${'word '.repeat(12)}`));
        const f = fixture(rows, {}, 256);
        const built = await f.run({}, [], { requireNewestUser: true });
        expect(built.prompt).toContain('row99'); expect(built.prompt).not.toContain('row0 ');
        expect(built.tokenBudget.usedTokens).toBeLessThanOrEqual(192);
        expect(built.tokenBudget.messageCount).toBeLessThan(100);
        expect(f.context.frame.metadata.lastInContextMessageId).toBeGreaterThan(0);
    });
    test('an uncapped short history is not reduced to a fixed row limit', async () => {
        const rows = Array.from({ length: 96 }, (_, i) => user(`m${i}`));
        const built = await fixture(rows).run();
        expect(built.tokenBudget.messageCount).toBe(96);
        expect(built.prompt).toContain('m0\n'); expect(built.prompt).toContain('m95');
    });
    test('pinned examples get source priority over history', async () => {
        const example = `EXAMPLE ${'word '.repeat(60)}\n`;
        const rows = Array.from({ length: 12 }, (_, i) => user(`row${i} ${'word '.repeat(20)}`));
        const pinned = await fixture(rows, { pin_examples: true }, 256).run({}, [example]);
        const unpinned = await fixture(rows, { pin_examples: false }, 256).run({}, [example]);
        expect(pinned.prompt).toContain('EXAMPLE'); expect(unpinned.prompt).not.toContain('EXAMPLE');
        expect(pinned.tokenBudget.messageCount).toBeLessThan(unpinned.tokenBudget.messageCount);
    });
    test('depth injections, story-in-chat and role sequences use the source injector', async () => {
        const f = fixture(undefined, { context: { story_string: '{{description}}', story_string_position: 1, story_string_depth: 1 }, instruct: { enabled: true, system_sequence: '[SYS]', names_behavior: 'none' } });
        f.context.frame.extensionPrompts.owned = { value: 'Owned depth', position: 1, depth: 0, role: 0 };
        const built = await f.run({ description: 'Story in chat' });
        expect(built.prompt).toContain('Owned depth'); expect(built.prompt).toContain('Story in chat');
        expect(built.prompt.indexOf('Greeting')).toBeLessThan(built.prompt.indexOf('Story in chat'));
        expect(built.prompt).toContain('[SYS]');
    });
    test('continue retains one prefix and no output suffix or fresh output head', async () => {
        const f = fixture([user('Question'), assistant('Partial reply')], { instruct: { enabled: true, names_behavior: 'none', output_sequence: '[OUT]', output_suffix: '[END]' }, context: { chat_start: '' } });
        const built = await f.run({}, [], { type: 'continue' });
        expect(built.prompt.endsWith('[OUT]\nPartial reply')).toBe(true);
        expect(built.prompt.match(/Partial reply/g)).toHaveLength(1);
        expect(built.prompt).not.toContain('[END]');
    });
    test('quiet prompt uses the source system head and is counted in the final packet', async () => {
        const f = fixture(undefined, { instruct: { enabled: true, names_behavior: 'none', last_system_sequence: '[QUIET]' } });
        const built = await f.run({}, [], { type: 'quiet', input: 'Summarize', preview: true });
        expect(built.prompt).toContain('Summarize'); expect(built.prompt.endsWith('[QUIET]\n')).toBe(true);
    });
    test('oversized mandatory story and dropped newest input fail before dispatch', async () => {
        await expect(fixture(undefined, {}, 128).run({ description: 'word '.repeat(300) })).rejects.toThrow('Mandatory string');
        await expect(fixture([user('word '.repeat(300))], {}, 128).run({}, [], { requireNewestUser: true })).rejects.toThrow('newest input');
    });
    test('packing does not mutate caller history or publish preview variable effects', async () => {
        const f = fixture(undefined, { context: { story_string: '{{description}}' } });
        const original = JSON.stringify(f.history);
        await f.run({ description: '{{incvar::counter}}' }, [], { preview: true });
        expect(JSON.stringify(f.history)).toBe(original);
        expect(f.context.effects().metadata.variables.counter).toBe(1);
        expect(f.context.effects().localDirty).toBe(true);
    });
    test.each([['Llama-3-Instruct', 'llama3'], ['mixtral', 'mistral'], ['Gemma', 'gemma'], ['unknown', 'llama'], ['nemo', 'nemo'], ['command-r', 'command-r']])('offline source tokenizer matching respects %s', (model, expected) => {
        const f = fixture();
        configureTextRuntime({ context: f.context, textSettings: { type: 'generic', generic_model: model } });
        expect(selectLocalTextTokenizer(f.context)).toBe(expected);
    });
    test.each([0, 2, 6, 9, 10, '3', -1])('tokenizer choice %s cannot become an estimate or remote request', tokenizer => {
        const f = fixture(undefined, { tokenizer });
        configureTextRuntime({ context: f.context });
        expect(() => selectLocalTextTokenizer(f.context)).toThrow();
    });
    test('worker string preparation isolates old Chat Completion budgets and can build an undispatched packet', async () => {
        const f = fixture(undefined, { tokenizer: 1, instruct: { enabled: true, names_behavior: 'none', output_sequence: '[OUT]' } });
        f.session.settings.oai_settings = { openai_max_context: 2, openai_max_tokens: 1, openai_model: 'old-chat-model' };
        f.session.settings.textgenerationwebui_settings = { type: 'generic', generic_model: 'OwnedTextModel', server_urls: { generic: 'https://private-connection.invalid' } };
        const before = JSON.stringify(f.chat);
        const built = await buildStringPrompt(f.session, { name: 'Aria', description: 'Chosen {{model}}' }, f.chat, { preview: true });
        expect(built.prompt).toContain('Chosen OwnedTextModel'); expect(built.prompt).not.toContain('old-chat-model');
        expect(built.warnings.tokenBudget.contextTokens).toBe(2048);
        expect(built.warnings.tokenBudget.responseTokens).toBe(64);
        expect(built.warnings.tokenBudget.tokenizerModel).toBe('gpt2');
        expect(JSON.stringify(built)).not.toContain('private-connection');
        expect(JSON.stringify(f.chat)).toBe(before);
        const packet = await buildPrompt(f.session, { name: 'Aria' }, f.chat, { type: 'normal' });
        expect(packet.providerRequest.provider_format).toBe('text-completions');
        expect(packet.providerRequest.prompt).toBe(packet.prompt);
    });
    test('worker string preview scans embedded WI and expands isolated variables with its selected local tokenizer', async () => {
        const f = fixture(undefined, { tokenizer: 1, context: { story_string: '{{wiBefore}}{{description}}' } });
        const character = { name: 'Aria', description: 'Pilot', character_book: { entries: [{ id: 4, keys: [], content: 'Owned lore {{incvar::loreCounter}}', enabled: true, constant: true, insertion_order: 1, position: 'before_char', extensions: {} }] } };
        const built = await buildStringPrompt(f.session, character, f.chat, { preview: true, characterId: 'guide' });
        expect(built.prompt).toContain('Owned lore 1');
        expect(built.macroEffects.metadata.variables.loreCounter).toBe(1);
        expect(built.warnings.worldInfoActivated).toContain('__embedded__:guide:4');
        expect(f.chat[0].chat_metadata).toEqual({});
    });
    test('source CFG reserves the larger branch and emits separate positive/negative strings', async () => {
        const f = fixture();
        const built = await f.run({}, [], { extensionSettings: { cfg: { global: { guidance_scale: 2, positive_prompt: 'Favor starlight', negative_prompt: 'Avoid darkness' }, chara: [] } } });
        expect(built.guidanceScale).toBe(2);
        expect(built.prompt).toContain('Favor starlight'); expect(built.prompt).not.toContain('Avoid darkness');
        expect(built.negativePrompt).toContain('Avoid darkness'); expect(built.negativePrompt).not.toContain('Favor starlight');
        expect(built.tokenBudget.negativeTokens).toBeGreaterThan(0);
    });
    test('an oversized CFG reservation cannot silently drop its negative prompt and pass the native audit', async () => {
        const f = fixture(undefined, {}, 128);
        await expect(f.run({}, [], { extensionSettings: { cfg: { global: { guidance_scale: 2, negative_prompt: 'word '.repeat(300) }, chara: [] } } })).rejects.toThrow('Mandatory string');
    });
    test('text prompting retains source reasoning-prefix behavior and enabled addition limits', async () => {
        const rows = [{ ...assistant('Older'), extra: { reasoning: 'old trace' } }, user('Question'), { ...assistant('Reply'), extra: { reasoning: 'new trace' } }];
        const f = fixture(rows, { reasoning: { add_to_prompts: true, max_additions: 1, prefix: '<r>', suffix: '</r>', separator: '\n' } });
        const built = await f.run();
        expect(built.prompt).toContain('<r>new trace</r>\nReply');
        expect(built.prompt).not.toContain('old trace');
    });
    test('text preset regex uses its own permissions and never inherits a Chat Completion preset grant', async () => {
        const f = fixture();
        const script = replaceString => ({ placement: [1], findRegex: '/Latest/g', replaceString, trimStrings: [], promptOnly: true });
        f.session.settings.oai_settings = { preset_settings_openai: 'Owned', extensions: { regex_scripts: [script('WrongChatScope')] } };
        f.session.settings.textgenerationwebui_settings = { type: 'generic', generic_model: 'llama', preset: 'Owned', extensions: { regex_scripts: [script('TextScope')] } };
        f.session.extensionSettings.preset_allowed_regex = { openai: ['Owned'] };
        const first = await buildStringPrompt(f.session, { name: 'Aria' }, f.chat, { preview: true });
        expect(first.prompt).toContain('Latest input'); expect(first.prompt).not.toContain('WrongChatScope');
        f.session.extensionSettings.preset_allowed_regex.textgenerationwebui = ['Owned'];
        const granted = await buildStringPrompt(f.session, { name: 'Aria' }, f.chat, { preview: true });
        expect(granted.prompt).toContain('TextScope input'); expect(granted.prompt).not.toContain('WrongChatScope');
    });
    test('exact final fitting handles Instruct token boundaries without replaying story macros', async () => {
        const rows = Array.from({ length: 96 }, (_, i) => i % 2 ? user(`row${i}`) : assistant(`row${i}`));
        const f = fixture(rows, { tokenizer: 3, instruct: { enabled: true, names_behavior: 'none', output_sequence: '[OUT]', output_suffix: '[END]' }, context: { story_string: '{{description}}', chat_start: '' } }, 256);
        const built = await f.run({ description: 'Counter {{incvar::exactCounter}}' }, [], { requireNewestUser: true });
        expect(built.prompt).toContain('Counter 1'); expect(built.prompt).toContain('row95');
        expect(built.prompt).not.toContain('row0[END]');
        expect(built.tokenBudget.usedTokens + built.tokenBudget.responseTokens).toBeLessThanOrEqual(256);
        expect(f.context.effects().metadata.variables.exactCounter).toBe(1);
        expect(f.context.frame.metadata.lastInContextMessageId).toBe(96 - built.tokenBudget.messageCount);
    });
    test('a fitting depth-zero injection cannot disguise omission of the newest oversized user input', async () => {
        const input = 'word '.repeat(300);
        const f = fixture([user(input)], {}, 128);
        f.context.frame.extensionPrompts.owned = { value: 'Small injection', position: 1, depth: 0, role: 0 };
        await expect(f.run({}, [], { requireNewestUser: true })).rejects.toThrow('newest input');
    });
});
