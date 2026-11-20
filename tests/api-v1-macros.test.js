import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from '@jest/globals';
import { generateHeadlessMacros } from '../scripts/generate-headless-macros.mjs';
import { createMacroContext, persistMacroEffects } from '../src/headless/macros.js';
import { buildPrompt } from '../src/headless/prompt.js';
import { readChat, readSettings, writeChat, writeSettings } from '../src/headless/session.js';

const roots = [];
function fixture(experimental = true) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-macros-'));
    roots.push(root);
    const directories = { root, worlds: path.join(root, 'worlds') };
    fs.mkdirSync(directories.worlds);
    const settings = {
        main_api: 'openai', oai_settings: { chat_completion_source: 'custom', custom_model: 'fixture', custom_url: 'http://127.0.0.1:3999/v1', openai_max_context: 4096, openai_max_tokens: 100, prompts: [{ identifier: 'main', content: 'Speak as {{char}}' }] },
        power_user: { experimental_macro_engine: experimental, context: { story_string: '{{description}}' } },
        extension_settings: { variables: { global: { shared: 'old' } }, unrelated: { preserve: true } },
    };
    writeSettings(directories, settings);
    const session = { directories, settings, userName: '读者🙂', extensionSettings: {} };
    const character = { name: 'Aria', description: 'Card for {{user}}', personality: 'Kind' };
    const chat = [{ chat_metadata: { variables: { count: 2 }, keep: 'metadata' } }, { name: 'Aria', is_user: false, mes: 'First' }, { name: '读者🙂', is_user: true, mes: 'Last' }];
    const chatPath = path.join(root, 'Chat.jsonl');
    writeChat(chatPath, chat);
    const options = { type: 'normal', characterId: 'Aria', chatId: 'Chat', nativeContext: { input: 'Draft', locale: 'en-US', timeZone: 'UTC', isMobile: false } };
    const context = createMacroContext(session, character, chat, options);
    return { session, character, chat, chatPath, context, options };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('source-derived native macro runtime', () => {
    test('generated engine and definitions match every authoritative upstream input', () => {
        expect(() => generateHeadlessMacros({ check: true })).not.toThrow();
    });
    test.each([true, false])('engine=%s expands environment, state, chat and variable macros without leaking frames', engine => {
        const first = fixture(engine);
        expect(first.context.expand('{{user}}|{{char}}|{{description}}|{{input}}|{{lastMessage}}|{{lastGenerationType}}')).toBe('读者🙂|Aria|Card for 读者🙂|Draft|Last|normal');
        expect(first.context.expand('{{setvar::n::4}}{{incvar::n}}/{{getvar::n}}/{{decvar::n}}')).toBe(engine ? '5/5/4' : '5/4/4');
        expect(first.context.expand('{{setglobalvar::shared::new}}{{getglobalvar::shared}}')).toBe('new');
        expect(first.context.effects()).toMatchObject({ localDirty: true, globalDirty: true, metadata: { variables: { count: 2, n: 4 } }, globals: { shared: 'new' } });
        const second = fixture(engine);
        expect(second.context.expand('{{getvar::n}}|{{getglobalvar::shared}}')).toBe('|old');
        expect(first.context.expand('{{getvar::n}}')).toBe('4');
    });
    test('conditional bodies are lazy and shorthand values use upstream variable operations', () => {
        const { context } = fixture();
        expect(context.expand('{{if false}}{{incvar::count}}{{else}}Skipped{{/if}}/{{getvar::count}}')).toBe('Skipped/2');
        expect(context.expand('{{if .count}}{{incvar::count}}{{/if}}/{{getvar::count}}')).toBe('3/3');
    });
    test('extension macros match upstream internal identifiers rather than display names', () => {
        const { session, character, chat, options } = fixture();
        const context = createMacroContext(session, character, chat, { ...options, extensions: [
            { id: 'local/Café', displayName: 'Other name', enabled: true },
            { id: 'global/Disabled', enabled: false },
        ] });
        expect(context.expand('{{hasExtension::cafe}}/{{hasExtension::third-party/CAFÉ}}/{{hasExtension::Other name}}/{{hasExtension::Disabled}}')).toBe('true/true/false/false');
    });
    test('original is consumed once per evaluation and unknown macros remain inspectable', () => {
        const { context } = fixture();
        expect(context.expand('{{original}}/{{original}}', { original: 'Base' })).toBe('Base/');
        expect(context.expand('{{unregisteredNativeFixture}}')).toBe('{{unregisteredNativeFixture}}');
        expect(context.expand('{{original}}', { original: 'Next' })).toBe('Next');
    });
    test('indexed variables and reserved property names cannot modify object prototypes', () => {
        const { context } = fixture();
        expect(context.expand('{{setvarkey::list::0::hello}}{{getvarkey::list::0}}')).toBe('hello');
        expect(context.expand('{{setvar::__proto__::safe}}{{getvar::__proto__}}')).toBe('safe');
        expect({}.safe).toBeUndefined();
        expect(context.effects().metadata.variables.__proto__).toBe('safe');
    });
    test('time zone, fixed time, seeded selection and random ranges use upstream handlers', () => {
        const { session, character, chat, options } = fixture();
        const context = createMacroContext(session, character, chat, { ...options, nativeContext: { ...options.nativeContext, now: Date.UTC(2026, 10, 20, 15, 4, 5) } });
        // Jest replaces process.env with a proxy, which does not apply Node's TZ
        // side effect. Exercise the production module in a real Node process.
        const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
            import { createMacroContext } from './src/headless/macros.js';
            const ctx = createMacroContext({settings:{},userName:'Reader'}, {name:'Aria'}, [], {nativeContext:{locale:'en',timeZone:'UTC',now:${Date.UTC(2026, 10, 20, 15, 4, 5)}}});
            console.log(ctx.expand('{{datetimeformat::YYYY-MM-DD HH:mm:ss}}'));
            console.log(process.env.TZ);
        `], { cwd: path.resolve('..'), env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
        expect(result.trim()).toBe('2026-11-20 15:04:05\nAmerica/New_York');
        expect(context.expand('{{pick::red::blue::green}}')).toBe(context.expand('{{pick::red::blue::green}}'));
        expect(['red', 'blue']).toContain(context.expand('{{random::red::blue}}'));
        const dice = Number(context.expand('{{roll::2d6}}'));
        expect(dice).toBeGreaterThanOrEqual(2); expect(dice).toBeLessThanOrEqual(12);
    });
    test('preview evaluates variable effects without writing settings or transcript', () => {
        const { session, character, chat, chatPath, options } = fixture();
        session.settings.oai_settings.prompts[0].content = '{{incvar::count}} {{setglobalvar::shared::preview}}';
        const before = fs.readFileSync(chatPath, 'utf8');
        const built = buildPrompt(session, character, chat, { ...options, preview: true });
        expect(built.warnings.macroStateChanges).toEqual({ local: true, global: true });
        expect(fs.readFileSync(chatPath, 'utf8')).toBe(before);
        expect(readSettings(session.directories).extension_settings.variables.global.shared).toBe('old');
    });
    test('publishing effects changes metadata only and merges independent settings writes', () => {
        const { session, chat, chatPath, context } = fixture();
        context.expand('{{incvar::count}}{{setglobalvar::shared::new}}');
        const latest = readSettings(session.directories); latest.username = 'Independent'; writeSettings(session.directories, latest);
        const staged = [...chat, { mes: 'Unanswered', is_user: true }];
        persistMacroEffects(session, chatPath, staged, context.effects());
        expect(readChat(chatPath)).toHaveLength(chat.length);
        expect(readChat(chatPath)[0].chat_metadata).toMatchObject({ keep: 'metadata', variables: { count: 3 } });
        expect(readSettings(session.directories)).toMatchObject({ username: 'Independent', extension_settings: { unrelated: { preserve: true }, variables: { global: { shared: 'new' } } } });
    });
    test('conflicting global mutation is rejected before any local effect is written', () => {
        const { session, chat, chatPath, context } = fixture();
        context.expand('{{incvar::count}}{{setglobalvar::shared::new}}');
        const latest = readSettings(session.directories); latest.extension_settings.variables.global.shared = 'Other'; writeSettings(session.directories, latest);
        expect(() => persistMacroEffects(session, chatPath, chat, context.effects())).toThrow('changed during prompt preparation');
        expect(readChat(chatPath)[0].chat_metadata.variables.count).toBe(2);
    });
    test('large inputs and excessive dice refuse evaluation with bounded errors', () => {
        const { context } = fixture();
        expect(() => context.expand('x'.repeat(1_048_577))).toThrow('size limit');
        expect(() => context.expand('{{roll::1000000000d6}}')).toThrow('limit');
        expect(() => fixture().context.expand('{{space::1000000000}}')).toThrow('limit');
        expect(() => fixture().context.expand('{{setvarkey::sparse::1000000000::value}}')).toThrow('limit');
    });
});
