import path from 'node:path';
import { beforeAll, describe, expect, test } from '@jest/globals';
import { generateHeadlessTextPrompt } from '../scripts/generate-headless-text-prompt.mjs';
import { createMacroContext } from '../src/headless/macros.js';
import { configureTextRuntime } from '../src/headless/text-runtime/platform.js';
import { defaultContextSettings, defaultInstructSettings } from '../src/headless/text-runtime/generated/defaults.js';
import { formatInstructModeChat, formatInstructModePrompt, formatInstructModeStoryString, formatInstructModeExamples, getInstructStoppingSequences, force_output_sequence } from '../src/headless/text-runtime/generated/instruct.js';
import { renderStoryString } from '../src/headless/text-runtime/generated/context.js';
import { setConfigFilePath } from '../src/util.js';
import { serverDirectory } from '../src/server-directory.js';

let encodeLocalTextTokens;
beforeAll(async () => {
    setConfigFilePath(path.join(serverDirectory, 'default/config.yaml'));
    ({ encodeLocalTextTokens } = await import('../src/endpoints/tokenizers.js'));
});
function frame(instruct = {}, context = {}) {
    const session = { userName: 'Reader', extensionSettings: {}, settings: { main_api: 'textgenerationwebui', max_context: 2048, amount_gen: 128, power_user: {} } };
    const value = createMacroContext(session, { name: 'Aria' }, [{ chat_metadata: {} }]);
    value.frame.powerUser.instruct = { ...defaultInstructSettings, enabled: true, ...instruct };
    value.frame.powerUser.context = { ...defaultContextSettings, ...context };
    configureTextRuntime({ context: value, tokenizer: 'llama', warnings: [] });
    return value;
}
describe('source-derived Instruct formatting foundation', () => {
    test('formatters, story/context and defaults match their five authoritative files', () => { expect(() => generateHeadlessTextPrompt({ check: true })).not.toThrow(); });
    test('first/last sequences, names, wrapping and narrator role use actual source choices', () => {
        frame({ names_behavior: 'always', input_sequence: '[U]', output_sequence: '[O]', first_input_sequence: '[FIRST]', last_output_sequence: '[LAST]', system_sequence: '[S]', input_suffix: '', output_suffix: '', system_suffix: '' });
        expect(formatInstructModeChat('Reader', 'Hi', true, false, false, 'Reader', 'Aria', force_output_sequence.FIRST)).toBe('[FIRST]\nReader: Hi\n');
        expect(formatInstructModeChat('Aria', 'Reply', false, false, false, 'Reader', 'Aria', force_output_sequence.LAST)).toBe('[LAST]\nAria: Reply\n');
        expect(formatInstructModeChat('', 'Narration', false, true, false, 'Reader', 'Aria', false)).toBe('[S]\nNarration\n');
    });
    test('template macros and name placeholders expand through the shared engine', () => {
        frame({ names_behavior: 'none', input_sequence: '[{{user}}/{{name}}]', macro: true });
        expect(formatInstructModeChat('Reader', 'Hi', true, false, false, 'Reader', 'Aria', false)).toBe('[Reader/Reader]\nHi\n');
    });
    test('story templates and system wrappers preserve source newline and in-chat behavior', () => {
        frame({ story_string_prefix: '<sys>', story_string_suffix: '</sys>' }, { story_string: '{{system}}|{{description}}' });
        const params = { system: 'Policy', description: 'Bio', char: 'Aria', user: 'Reader' };
        expect(formatInstructModeStoryString(renderStoryString(params))).toBe('<sys>\nPolicy|Bio</sys>');
        frame({ story_string_prefix: '<sys>', story_string_suffix: '</sys>' }, { story_string: '{{system}}|{{description}}', story_string_position: 1 });
        expect(formatInstructModeStoryString(renderStoryString(params))).toBe('Policy|Bio');
    });
    test('example messages use Instruct user/assistant sequences and configured separators', () => {
        frame({ names_behavior: 'always', input_sequence: '[I]', output_sequence: '[O]' }, { example_separator: '***' });
        expect(formatInstructModeExamples(['<START>\nReader: Hi\nAria: Reply'], 'Reader', 'Aria').join('')).toBe('***\n[I]\nReader: Hi\n[O]\nAria: Reply\n');
    });
    test('quiet output heads and stopping sequences remain source-controlled', () => {
        frame({ output_sequence: '[O]', last_output_sequence: '[LAST]', last_system_sequence: '[SYS]', stop_sequence: '[STOP]', names_behavior: 'none' });
        expect(formatInstructModePrompt('System', false, '', 'Reader', 'Aria', true, false)).toBe('[SYS]\n');
        const stops = getInstructStoppingSequences();
        expect(stops).toContain('\n[STOP]'); expect(stops).toContain('\n***');
    });
    test.each(['llama', 'llama3', 'gpt2'])('local %s encoding uses real IDs without endpoint/network fallbacks', async model => {
        const ids = await encodeLocalTextTokens('Hello world', model);
        expect(ids.length).toBeGreaterThan(0); expect(ids.every(id => Number.isInteger(id) && id >= 0)).toBe(true);
    });
    test('an unavailable/unsupported encoder fails rather than estimating character counts', async () => {
        await expect(encodeLocalTextTokens('Text', 'not-a-tokenizer')).rejects.toThrow('unsupported');
    });
});
