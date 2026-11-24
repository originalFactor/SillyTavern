import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from '@jest/globals';
import { buildPrompt } from '../dist/src/headless/prompt.js';
import { writeSettings, readSettings } from '../dist/src/headless/session.js';

const roots = [];
function fixture({ context = 4096, response = 100, prompts, order, oai = {}, power = {} } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-source-prompt-')); roots.push(root);
    const settings = { main_api: 'openai', power_user: power, oai_settings: { chat_completion_source: 'openai', openai_model: 'gpt-4', openai_max_context: context, openai_max_tokens: response, new_chat_prompt: '', prompts: prompts ?? [{ identifier: 'main', content: 'Main' }], prompt_order: [{ character_id: 100001, order: (order ?? ['main', 'charDescription', 'personaDescription', 'dialogueExamples', 'chatHistory', 'jailbreak']).map(value => typeof value === 'string' ? { identifier: value, enabled: true } : value) }], ...oai } };
    const session = { handle: 'source-prompt', directories: { root }, settings, extensionSettings: {}, userName: 'Reader' };
    return { session, character: { name: 'Aria', description: 'Character' }, chat: [{ chat_metadata: {} }], build(chat, options = {}) { return buildPrompt(session, this.character, chat, { type: 'normal', characterId: 'Aria', chatId: 'Chat', ...options }); } };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const rows = (count, content = i => `Line ${i}`) => Array.from({ length: count }, (_, index) => ({ name: index % 2 ? 'Aria' : 'Reader', is_user: index % 2 === 0, mes: content(index) }));
const history = result => result.messages.filter(message => ['user', 'assistant'].includes(message.role));
describe('source-derived Chat Completion packing', () => {
    test('reconstructs stored tool invocations and audits the resulting prompt without executing tools', async () => {
        const f = fixture({ oai: { function_calling: true } });
        const chat = [...f.chat, { name: 'Reader', is_user: true, mes: 'Question' }, {
            name: 'System', is_system: true, mes: 'Tool call',
            extra: { tool_invocations: [{ id: 'call_1', name: 'lookup', parameters: '{"query":"hello"}', result: 'Found' }] },
        }, { name: 'Aria', is_user: false, mes: 'Answer' }];
        const built = await f.build(chat);
        expect(built.messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"query":"hello"}' } }] }),
            expect.objectContaining({ role: 'tool', tool_call_id: 'call_1', content: 'Found' }),
        ]));
    });
    test('rejects invalid stored tool calls before dispatch and omits system calls when function calling is disabled', async () => {
        const f = fixture({ oai: { function_calling: true } });
        const toolRow = { name: 'System', is_system: true, mes: 'Tool call', extra: { tool_invocations: [{ id: 'same', name: 'lookup', parameters: '{}', result: 'one' }, { id: 'same', name: 'lookup', parameters: '{}', result: 'two' }] } };
        await expect(f.build([...f.chat, toolRow])).rejects.toThrow('stored tool invocation is invalid');
        toolRow.extra.tool_invocations = [];
        await expect(f.build([...f.chat, toolRow])).rejects.toThrow('stored tool invocation is invalid');
        f.session.settings.oai_settings.function_calling = false;
        const built = await f.build([...f.chat, toolRow, ...rows(1)]);
        expect(built.messages.some(message => message.tool_calls || message.role === 'tool')).toBe(false);
    });
    test('group prompt assembly includes the group nudge and speaker names', async () => {
        const f = fixture({ prompts: [{ identifier: 'main', content: 'Members: {{group}}' }], oai: { group_nudge_prompt: 'Speak as {{char}}', new_group_chat_prompt: 'Members: {{group}}' } });
        const groupContext = {
            group: { id: 'group', members: ['first.png', 'second.png'], disabled_members: [], generation_mode: 0 },
            characters: [{ ...f.character, avatar: 'first.png', data: f.character }, { name: 'Bob', avatar: 'second.png', data: { name: 'Bob' } }],
            characterIndex: 0,
        };
        const built = await f.build([...f.chat, { name: 'Bob', is_user: false, mes: 'Hello' }], { groupContext });
        expect(built.messages.some(message => message.content.includes('Bob: Hello'))).toBe(true);
        expect(built.messages.some(message => message.content.includes('Speak as Aria'))).toBe(true);
        expect(built.messages.some(message => message.content.includes('Members: Aria, Bob'))).toBe(true);
    });
    test('retains long history without context trimming', async () => {
        const f = fixture({ context: 8192 }); const all = rows(96);
        const built = await f.build([...f.chat, ...all]);
        expect(history(built)).toHaveLength(96); expect(history(built)[0].content).toBe('Line 0'); expect(history(built).at(-1).content).toBe('Line 95');
        expect(built.macroEffects.metadata.lastInContextMessageId).toBe(0);
    });
    test('source-supported depths above the former native limit remain represented and ordered', async () => {
        const f = fixture({ prompts: [{ identifier: 'main', content: 'Main' }, { identifier: 'deep', role: 'system', content: 'Deep injection', system_prompt: false, injection_position: 1, injection_depth: 1000, injection_order: 100 }], order: ['main', 'deep', 'chatHistory'] });
        const built = await f.build([...f.chat, ...rows(3)]);
        const contents = built.messages.map(message => message.content);
        expect(contents).toContain('Deep injection'); expect(contents.indexOf('Deep injection')).toBeLessThan(contents.indexOf('Line 0'));
    });
    test('mandatory prompts cannot yield a partial request or publish variables when they exceed context', async () => {
        const f = fixture({ context: 64, response: 32, prompts: [{ identifier: 'main', content: '{{setglobalvar::mustNotPublish::yes}}' + 'token '.repeat(200) }] });
        writeSettings(f.session.directories, { extension_settings: { variables: { global: {} } } });
        await expect(f.build([...f.chat, ...rows(2)])).rejects.toThrow('Mandatory prompts exceed');
        expect(readSettings(f.session.directories).extension_settings.variables.global).toEqual({});
    });
    test('a newly staged user input that cannot fit is an explicit pre-dispatch error, not silently omitted', async () => {
        const f = fixture({ context: 128, response: 32 }); const input = 'input '.repeat(300);
        await expect(f.build([...f.chat, { name: 'Reader', is_user: true, mes: input }], { input, stageUserInput: true })).rejects.toThrow('newest input cannot fit');
    });
    test('pinned examples reserve their source group atomically before history; unpinned history takes priority', async () => {
        const f = fixture({ context: 256, response: 32 }); f.character.mes_example = '<START>\nReader: Example\nAria: Example response';
        const chat = [...f.chat, ...rows(96, i => `Line ${i}: ${'word '.repeat(10)}`)];
        const normal = await f.build(chat); expect(normal.messages.some(message => message.name === 'example_user')).toBe(false);
        f.session.settings.power_user.pin_examples = true;
        const pinned = await f.build(chat); expect(pinned.messages.some(message => message.name === 'example_user' && message.content === 'Example')).toBe(true);
        expect(history(pinned).length).toBeLessThanOrEqual(history(normal).length);
    });
    test('reasoning uses source prefix/suffix, addition limits and prompt-only reasoning regex', async () => {
        const f = fixture({ power: { reasoning: { add_to_prompts: true, max_additions: 1, prefix: '<r>', suffix: '</r>', separator: '\n' } } });
        f.session.extensionSettings.regex = [{ placement: [6], findRegex: '/trace/g', replaceString: 'reasoned', trimStrings: [], substituteRegex: 0, promptOnly: true }];
        const built = await f.build([...f.chat, { mes: 'Older', is_user: false, extra: { reasoning: 'trace old', api: 'openai', model: 'gpt-4' } }, { mes: 'Question', is_user: true }, { mes: 'Latest', is_user: false, extra: { reasoning: 'trace new', api: 'openai', model: 'gpt-4' } }]);
        expect(history(built).map(message => message.content)).toEqual(['Older', 'Question', '<r>reasoned new</r>\nLatest']);
    });
    test('continue nudge and assistant prefill are separately reserved by source packing', async () => {
        const f = fixture({ oai: { continue_nudge_prompt: 'Nudge {{lastChatMessage}}', continue_prefill: false } });
        const chat = [...f.chat, { mes: 'Question', name: 'Reader', is_user: true }, { mes: 'Latest', name: 'Aria', is_user: false }];
        const nudge = await f.build(chat, { type: 'continue' });
        expect(nudge.messages.at(-1).content).toBe('Nudge Latest'); expect(nudge.messages.at(-2)).toMatchObject({ role: 'assistant', content: 'Latest' });
        f.session.settings.oai_settings.continue_prefill = true;
        const prefill = await f.build(chat, { type: 'continue' });
        expect(prefill.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Latest' });
        expect(prefill.messages.some(message => message.content === 'Nudge Latest')).toBe(false);
    });
    test('source name handling and system squashing preserve named examples', async () => {
        const f = fixture({ oai: { names_behavior: 1, squash_system_messages: true } }); f.character.mes_example = '<START>\nReader: Example\nAria: Response';
        const built = await f.build([...f.chat, { mes: 'Question', name: '读者🙂', is_user: true }]);
        expect(built.messages.some(message => message.role === 'user' && message.name === '____')).toBe(true);
        expect(built.messages.some(message => message.name === 'example_user')).toBe(true);
        expect(built.messages[0].content).toBe('Main\nCharacter');
    });
});
