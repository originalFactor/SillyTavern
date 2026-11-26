import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../client/lib/extension-runtime/cleanup.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } });
const exports = {}; new Function('exports', outputText)(exports);
// Reconstruct the serialized function exactly as the browser does.
const install = new Function(`return (${exports.installExtensionCleanup.toString()});`)();
const defaults = { mainApi: 'openai', exampleSeparator: '', hasUserPromptBias: false, allow_name1_display: true, allow_name2_display: true, collapse_newlines: false, auto_fix_generated_markdown: false, trim_sentences: false, trim_spaces: false };
async function runtime(settings = {}, overrides = {}) {
    const calls = [];
    const api = install({}, {
        unsupported: name => { throw Error(`Unsupported: ${name}`); },
        getContext: () => ({}), reasoning: { getMainApi: () => 'openai' },
        regex: { regex_placement: { USER_INPUT: 1, AI_OUTPUT: 2 }, getRegexedString(text, placement) { calls.push([text, placement]); return text; } },
        request: async (operation, args) => { expect(operation).toBe('script.cleanupSettings'); expect(args).toEqual({}); return { ...defaults, ...settings }; },
        ...overrides,
    });
    await api.initialize();
    return { api, calls };
}
const clean = (api, text, options = {}) => api.cleanUpMessage({ getMessage: text, stoppingStrings: [], ...options });

describe('source-derived isolated text cleanup', () => {
    test('keeps the source empty-message branch usable before loading settings', () => {
        const api = install({}, {});
        for (const value of [undefined, '', 0, false, NaN]) {
            expect(api.cleanUpMessage(value)).toBe('');
            expect(api.cleanUpMessage({ getMessage: value })).toBe('');
        }
        expect(() => api.cleanUpMessage(null)).toThrow(TypeError);
    });
    test('matches complete and partial stopping-string suffix removal in order', async () => {
        const { api, calls } = await runtime();
        for (const [text, stops, expected] of [
            ['reply STOP', ['STOP'], 'reply'], ['reply ST', ['STOP'], 'reply'],
            ['STOP reply', ['STOP'], 'STOP reply'], ['reply STOP!', ['STOP'], 'reply STOP!'],
            ['reply STOPEND', ['END', 'STOP'], 'reply'], ['reply STOPEND', ['STOP', 'END'], 'reply STOP'],
            ['hello 😀', ['😀stop'], 'hello'], ['hello', [''], 'hello'],
        ]) expect(clean(api, text, { stoppingStrings: stops })).toBe(expected);
        expect(calls[0]).toEqual(['reply ', 2]);
        expect(clean(api, '  impersonated  ', { isImpersonate: true })).toBe('impersonated');
        expect(calls.at(-1)).toEqual(['  impersonated  ', 1]);
    });
    test('runs regex before newline, invisible whitespace, end marker and Markdown cleanup', async () => {
        const { api } = await runtime({ collapse_newlines: true, auto_fix_generated_markdown: true }, {
            regex: { regex_placement: { AI_OUTPUT: 2 }, getRegexedString: () => '* text *   \n\nrest\t\n<|endoftext|>ignored' },
        });
        expect(clean(api, 'raw')).toBe('*text*\nrest\n');
        expect((await runtime()).api.cleanUpMessage({ getMessage: 'first\r\nnext  \n  ', stoppingStrings: [] })).toBe('first\r\nnext\n');
    });
    test('preserves object defaults and the legacy positional omission behavior', async () => {
        const { api } = await runtime({ hasUserPromptBias: true });
        expect(() => clean(api, 'reply')).toThrow('prompt bias');
        expect(api.cleanUpMessage('reply', false, false, false, [])).toBe('reply');
        expect(() => api.cleanUpMessage('reply', false, false, false, [], true)).toThrow('prompt bias');
    });
    test('honors sentence/space settings and displayIncompleteSentences', async () => {
        const { api } = await runtime({ trim_sentences: true, trim_spaces: true });
        expect(clean(api, '  Complete. incomplete  ')).toBe('Complete.');
        expect(clean(api, '  Complete. incomplete  ', { displayIncompleteSentences: true })).toBe('Complete. incomplete');
        expect(clean(api, '  开始。未完')).toBe('开始。');
    });
    test('rejects unbound generation/name/macro state before regex evaluation', async () => {
        const { api, calls } = await runtime({ allow_name1_display: false });
        expect(() => clean(api, 'reply')).toThrow('name stripping');
        expect(clean(api, 'reply', { trimWrongNames: false })).toBe('reply');
        expect(() => clean(api, 'reply', { isImpersonate: true })).toThrow('name stripping');
        expect(clean(api, 'reply', { isImpersonate: true, trimNames: false })).toBe('reply');
        const { api: character, calls: skipped } = await runtime({ allow_name2_display: false });
        expect(() => clean(character, 'reply', { trimWrongNames: false, trimNames: false })).toThrow('name stripping');
        expect(() => character.cleanUpMessage({ getMessage: 'reply' })).toThrow('stopping strings');
        expect(skipped).toEqual([]); expect(calls).toHaveLength(2);
        for (const context of [{ characterId: 0 }, { groupId: 'team' }, { chat: [] }]) {
            const { api } = await runtime({}, { getContext: () => context });
            expect(() => clean(api, 'reply')).toThrow('not bound');
        }
    });
    test('never guesses missing settings, other APIs, or malformed arguments', async () => {
        const { api: missing } = await runtime({}, { request: async () => ({ mainApi: 'openai' }) });
        expect(() => clean(missing, 'reply')).toThrow('hasUserPromptBias setting is unavailable');
        const { api: other } = await runtime({ mainApi: 'kobold' }, { reasoning: { getMainApi: () => 'kobold' } });
        expect(() => clean(other, 'reply')).toThrow('only Chat Completion');
        const { api: stale } = await runtime({}, { reasoning: { getMainApi: () => 'textgenerationwebui' } });
        expect(() => clean(stale, 'reply')).toThrow('settings changed');
        const { api } = await runtime();
        for (const value of [1, true, {}, []]) expect(() => clean(api, value)).toThrow(TypeError);
        for (const value of ['STOP', {}, [1]]) expect(() => clean(api, 'reply', { stoppingStrings: value })).toThrow(TypeError);
    });
    test('initialization is non-exported, deduplicated and latches failures', async () => {
        let calls = 0;
        const api = install({}, { request: async () => { calls++; throw Error('settings unavailable'); } });
        expect(Object.keys(api)).not.toContain('initialize');
        await expect(api.initialize()).rejects.toThrow('settings unavailable');
        await expect(api.initialize()).rejects.toThrow('settings unavailable');
        expect(calls).toBe(1);
    });
    test('preserves card-field passthrough before initialization and requires settings for nonempty strings', () => {
        const api = install({}, { unsupported: name => { throw Error(name); } });
        for (const value of [undefined, null, '', false, 0, 42, [], {}, new String('text')]) expect(api.baseChatReplace(value)).toBe(value);
        expect(() => api.baseChatReplace('text')).toThrow('baseChatReplace (settings snapshot');
        for (const value of [undefined, null, false, 0, '', [], '<START>']) expect(api.parseMesExamples(value)).toEqual([]);
        for (const value of [1, true, {}, ['text']]) expect(() => api.parseMesExamples(value)).toThrow(TypeError);
        expect(() => api.parseMesExamples('example')).toThrow('parseMesExamples (settings snapshot');
    });
    test('preprocesses literal card fields in source order without trimming or applying output regex', async () => {
        for (const collapse of [false, true]) {
            const { api, calls } = await runtime({ collapse_newlines: collapse });
            const input = '  card\r\n\ntext\r\n\r\nnext\r  ';
            // Collapsing happens before removing CR: CR-separated newlines must
            // remain separate, even when collapse_newlines is enabled.
            expect(api.baseChatReplace(input, 'User', 'Character')).toBe(collapse ? '  card\ntext\n\nnext  ' : '  card\n\ntext\n\nnext  ');
            expect(api.baseChatReplace('** bold ** <START>')).toBe('** bold ** <START>');
            expect(calls).toEqual([]);
        }
    });
    test('rejects curly and case-insensitive legacy macros instead of pretending to evaluate them', async () => {
        const { api } = await runtime();
        for (const macro of ['{{user}}', '{{setvar::x::1}}', '{{random::a::b}}', '{{', '<USER>', '<bot>', '<cHaR>', '<CHARIFNOTGROUP>', '<GROUP>']) {
            expect(() => api.baseChatReplace(`before ${macro} after`, 'Explicit user', 'Explicit character')).toThrow('baseChatReplace (macro evaluation');
            const { api: parser } = await runtime({ exampleSeparator: macro });
            // Separator substitution is still evaluated in the source even
            // when the selected API or Instruct would use a different heading.
            for (const instruct of [false, true]) expect(() => parser.parseMesExamples('example', instruct)).toThrow('parseMesExamples (macro evaluation');
        }
    });
    test('splits examples using the source case-sensitive prefix and case-insensitive delimiters', async () => {
        const { api } = await runtime();
        const cases = [
            ['example', ['<START>\nexample\n']],
            ['  example  ', ['<START>\nexample\n']],
            ['<START>\nfirst\n<start>\nsecond  ', ['<START>\nfirst\n', '<START>\nsecond\n']],
            ['<start>first', ['<START>\n\n', '<START>\nfirst\n']],
            [' <START>first', ['<START>\n\n', '<START>\nfirst\n']],
            ['<START><START>', ['<START>\n\n', '<START>\n\n']],
            ['<START>\n', ['<START>\n\n']],
            ['   ', ['<START>\n\n']],
            ['<START>{{user}}: hello <USER>', ['<START>\n{{user}}: hello <USER>\n']],
        ];
        for (const [input, expected] of cases) expect(api.parseMesExamples(input, false)).toEqual(expected);
        const first = api.parseMesExamples('example'); first.push('local change');
        expect(api.parseMesExamples('example')).toEqual(['<START>\nexample\n']);
    });
    test('honors captured context separators for text APIs and the explicit Instruct heading', async () => {
        for (const mainApi of ['kobold', 'textgenerationwebui', 'openai']) {
            for (const exampleSeparator of ['', '---', '  separator  ', 'line\r\n']) {
                const { api } = await runtime({ mainApi, exampleSeparator }, { reasoning: { getMainApi: () => mainApi } });
                expect(api.parseMesExamples('first<START>second', false)).toEqual(['first', 'second'].map(text => `${mainApi === 'openai' ? '<START>\n' : exampleSeparator ? exampleSeparator + '\n' : ''}${text}\n`));
                for (const instruct of [true, 1, 'enabled']) expect(api.parseMesExamples('example', instruct)).toEqual(['<START>\nexample\n']);
            }
        }
    });
    test('fails visibly on missing settings and API changes while keeping empty branches available', async () => {
        const { api: missing } = await runtime({}, { request: async () => ({ mainApi: 'openai' }) });
        expect(() => missing.baseChatReplace('text')).toThrow('baseChatReplace (collapse_newlines setting is unavailable');
        expect(() => missing.parseMesExamples('example')).toThrow('parseMesExamples (exampleSeparator setting is unavailable');
        const { api } = await runtime({}, { reasoning: { getMainApi: () => 'kobold' } });
        expect(() => api.parseMesExamples('example')).toThrow('API settings changed');
        expect(api.parseMesExamples('<START>')).toEqual([]);
    });
    test('exposes source-compatible standalone formatting helpers', async () => {
        const { api } = await runtime();
        expect(api.collapseNewlines('a\n\n\nb\r\n\r\nc')).toBe('a\nb\r\n\r\nc');
        expect(api.fixMarkdown('** bold ** and _ italic _', false)).toBe('**bold** and _italic_');
        expect(api.fixMarkdown('unclosed *text', false)).toBe('unclosed *text');
        expect(api.fixMarkdown('unclosed *text', true)).toBe('unclosed *text*');
        // Source iterates both checks against the original line.
        expect(api.fixMarkdown('*both "', true)).toBe('*both ""');
        for (const [text, expected] of [['no punctuation  ', 'no punctuation'], ['complete. rest', 'complete.'], ['完成。未完', '完成。'], ['emoji 😀 suffix', 'emoji 😀'], ['space ! more', 'space'], ['', '']]) expect(api.trimToEndSentence(text)).toBe(expected);
    });
});
