import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from '@jest/globals';
import { generateHeadlessMacros } from '../scripts/generate-headless-macros.mjs';
import { createMacroChat, createMacroContext, persistMacroEffects } from '../src/headless/macros.js';
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
    test.each([true, false])('engine=%s expands group macros with the selected speaker and muted members', engine => {
        const { session, character, chat, options } = fixture(engine);
        const groupContext = {
            group: { id: 'group', members: ['Aria.png', 'Bob.png'], disabled_members: ['Bob.png'] },
            characters: [
                { ...character, avatar: 'Aria.png', data: character },
                { name: 'Bob', avatar: 'Bob.png', data: { name: 'Bob' } },
            ],
            characterIndex: 0,
        };
        const context = createMacroContext(session, character, chat, { ...options, groupContext });
        expect(context.expand('{{group}}')).toBe('Aria, Bob');
        expect(context.expand('{{groupNotMuted}}')).toBe('Aria');
        expect(context.expand('{{char}}')).toBe('Aria');
    });
    test.each([true, false])('engine=%s joins group card fields using upstream modes', engine => {
        const { session, character, chat, options } = fixture(engine);
        const group = { id: 'group', members: ['Aria.png', 'Bob.png'], disabled_members: ['Bob.png'], generation_mode: 1, generation_mode_join_prefix: '<FIELDNAME> {{char}}: ', generation_mode_join_suffix: '' };
        const characters = [{ ...character, avatar: 'Aria.png', data: character }, { name: 'Bob', avatar: 'Bob.png', description: 'Bob description', data: { name: 'Bob' } }];
        const context = createMacroContext(session, character, chat, { ...options, groupContext: { group, characters, characterIndex: 0 } });
        expect(context.fields().description).toBe('Description Aria: Card for 读者🙂');
        group.generation_mode = 2;
        const includingMuted = createMacroContext(session, character, chat, { ...options, groupContext: { group, characters, characterIndex: 0 } });
        expect(includingMuted.fields().description).toBe('Description Aria: Card for 读者🙂\nDescription Bob: Bob description');
    });
    test('generated engine and definitions match every authoritative upstream input', async () => {
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
    test('conditional bodies are lazy and shorthand values use upstream variable operations', async () => {
        const { context } = fixture();
        expect(context.expand('{{if false}}{{incvar::count}}{{else}}Skipped{{/if}}/{{getvar::count}}')).toBe('Skipped/2');
        expect(context.expand('{{if .count}}{{incvar::count}}{{/if}}/{{getvar::count}}')).toBe('3/3');
    });
    test('extension macros match upstream internal identifiers rather than display names', async () => {
        const { session, character, chat, options } = fixture();
        const context = createMacroContext(session, character, chat, { ...options, extensions: [
            { id: 'local/Café', displayName: 'Other name', enabled: true },
            { id: 'global/Disabled', enabled: false },
        ] });
        expect(context.expand('{{hasExtension::cafe}}/{{hasExtension::third-party/CAFÉ}}/{{hasExtension::Other name}}/{{hasExtension::Disabled}}')).toBe('true/true/false/false');
    });
    test('original is consumed once per evaluation and unknown macros remain inspectable', async () => {
        const { context } = fixture();
        expect(context.expand('{{original}}/{{original}}', { original: 'Base' })).toBe('Base/');
        expect(context.expand('{{unregisteredNativeFixture}}')).toBe('{{unregisteredNativeFixture}}');
        expect(context.expand('{{original}}', { original: 'Next' })).toBe('Next');
    });
    test('indexed variables and reserved property names cannot modify object prototypes', async () => {
        const { context } = fixture();
        expect(context.expand('{{setvarkey::list::0::hello}}{{getvarkey::list::0}}')).toBe('hello');
        expect(context.expand('{{setvar::__proto__::safe}}{{getvar::__proto__}}')).toBe('safe');
        expect({}.safe).toBeUndefined();
        expect(context.effects().metadata.variables.__proto__).toBe('safe');
    });
    test('time zone, fixed time, seeded selection and random ranges use upstream handlers', async () => {
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
    test('preview evaluates variable effects without writing settings or transcript', async () => {
        const { session, character, chat, chatPath, options } = fixture();
        session.settings.oai_settings.prompts[0].content = '{{incvar::count}} {{setglobalvar::shared::preview}}';
        const before = fs.readFileSync(chatPath, 'utf8');
        const built = await buildPrompt(session, character, chat, { ...options, preview: true });
        expect(built.warnings.macroStateChanges).toEqual({ local: true, global: true });
        expect(fs.readFileSync(chatPath, 'utf8')).toBe(before);
        expect(readSettings(session.directories).extension_settings.variables.global.shared).toBe('old');
    });
    test('publishing effects changes metadata only and merges independent settings writes', async () => {
        const { session, chat, chatPath, context } = fixture();
        context.expand('{{incvar::count}}{{setglobalvar::shared::new}}');
        const latest = readSettings(session.directories); latest.username = 'Independent'; writeSettings(session.directories, latest);
        const staged = [...chat, { mes: 'Unanswered', is_user: true }];
        persistMacroEffects(session, chatPath, staged, context.effects());
        expect(readChat(chatPath)).toHaveLength(chat.length);
        expect(readChat(chatPath)[0].chat_metadata).toMatchObject({ keep: 'metadata', variables: { count: 3 } });
        expect(readSettings(session.directories)).toMatchObject({ username: 'Independent', extension_settings: { unrelated: { preserve: true }, variables: { global: { shared: 'new' } } } });
    });
    test('conflicting global mutation is rejected before any local effect is written', async () => {
        const { session, chat, chatPath, context } = fixture();
        context.expand('{{incvar::count}}{{setglobalvar::shared::new}}');
        const latest = readSettings(session.directories); latest.extension_settings.variables.global.shared = 'Other'; writeSettings(session.directories, latest);
        expect(() => persistMacroEffects(session, chatPath, chat, context.effects())).toThrow('changed during prompt preparation');
        expect(readChat(chatPath)[0].chat_metadata.variables.count).toBe(2);
    });
    test('large inputs and excessive dice refuse evaluation with bounded errors', async () => {
        const { context } = fixture();
        expect(() => context.expand('x'.repeat(1_048_577))).toThrow('size limit');
        expect(() => context.expand('{{roll::1000000000d6}}')).toThrow('limit');
        expect(() => fixture().context.expand('{{space::1000000000}}')).toThrow('limit');
        expect(() => fixture().context.expand('{{setvarkey::sparse::1000000000::value}}')).toThrow('limit');
    });
    test('variable allocation quota includes names, not just stored values', async () => {
        const { context } = fixture();
        const name = 'k'.repeat(524288);
        for (let index = 0; index < 15; index++) context.frame.metadata.variables[name + index] = 'v';
        expect(() => { context.frame.metadata.variables[name + 15] = 'v'; }).toThrow('state exceeded its size limit');
    });
    test.each([true, false])('new chat greeting and local variables commit together; duplicate IDs have no effects (engine=%s)', async engine => {
        const { session, character } = fixture(engine);
        session.directories.chats = path.join(session.directories.root, 'chats');
        const result = await createMacroChat(session, character, 'Aria', 'New', 'Hi {{user}}: {{incvar::greetings}}{{setglobalvar::shared::greeted}}');
        const saved = readChat(path.join(session.directories.chats, 'Aria', 'New.jsonl'));
        expect(saved[0].chat_metadata.variables.greetings).toBe(1);
        expect(saved[1].mes).toBe('Hi 读者🙂: 1');
        expect(result.warnings.macroStateChanges).toEqual({ local: true, global: true });
        expect(readSettings(session.directories).extension_settings.variables.global.shared).toBe('greeted');
        await expect(createMacroChat(session, character, 'Aria', 'New', '{{setglobalvar::shared::must-not-run}}')).rejects.toThrow('already exists');
        expect(readSettings(session.directories).extension_settings.variables.global.shared).toBe('greeted');
    });
    test('upstream eager character-field preparation evaluates the original greeting again in a dry-run frame', async () => {
        const { session, character, options } = fixture();
        session.directories.chats = path.join(session.directories.root, 'chats');
        character.first_mes = 'Greeting {{incvar::greetCount}}';
        await createMacroChat(session, character, 'Aria', 'Eager', character.first_mes);
        const chatPath = path.join(session.directories.chats, 'Aria', 'Eager.jsonl');
        const built = await buildPrompt(session, character, readChat(chatPath), { ...options, preview: true });
        expect(built.macroEffects.metadata.variables.greetCount).toBe(2);
        expect(readChat(chatPath)[0].chat_metadata.variables.greetCount).toBe(1);
        expect(readChat(chatPath)[1].mes).toBe('Greeting 1');
    });
    test('greeting warnings remain with their stored message for native navigation/recreation', async () => {
        const { session, character } = fixture();
        session.directories.chats = path.join(session.directories.root, 'chats');
        const created = await createMacroChat(session, character, 'Aria', 'Warning', 'Greeting {{space::invalid}}');
        expect(created.warnings.macroWarnings.length).toBeGreaterThan(0);
        const saved = readChat(path.join(session.directories.chats, 'Aria', 'Warning.jsonl'));
        expect(saved[1].extra.native_macro_warnings).toEqual(created.warnings.macroWarnings);
    });
    test('failed greeting publication reports already-published global effects without retrying', async () => {
        const { session, character } = fixture();
        session.directories.chats = path.join(session.directories.root, 'chats');
        fs.mkdirSync(session.directories.chats);
        fs.writeFileSync(path.join(session.directories.chats, 'Aria'), 'blocks chat directory');
        await expect(createMacroChat(session, character, 'Aria', 'Failure', '{{setglobalvar::shared::published}}Greeting')).rejects.toThrow('Global variable changes may already be saved');
        expect(readSettings(session.directories).extension_settings.variables.global.shared).toBe('published');
    });
});
