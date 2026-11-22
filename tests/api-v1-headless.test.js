import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';

import { errorBody, mergePatch, requireSafeId } from '../src/headless/contract.js';
import { buildPrompt, runNativeText } from '../src/headless/prompt.js';
import { regex_placement } from '../src/headless/regex-runtime.js';
import { normalizeCharacterData, patchSettings, readSettings, writeSettings } from '../src/headless/session.js';

const temporaryDirectories = [];

function makeDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-headless-'));
    const directories = {
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        extensions: path.join(root, 'extensions'),
        worlds: path.join(root, 'worlds'),
    };
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    temporaryDirectories.push(root);
    return directories;
}

function makeSession(overrides = {}) {
    return {
        handle: 'test-user',
        directories: makeDirectories(),
        userName: 'Native User',
        extensionSettings: { regex: [] },
        settings: {
            main_api: 'openai',
            max_context: 16,
            amount_gen: 100,
            oai_settings: {
                chat_completion_source: 'custom',
                custom_model: 'mock-model',
                custom_url: 'http://127.0.0.1:3999/v1',
                openai_max_context: 4096,
                openai_max_tokens: 100,
                prompts: [{ identifier: 'main', enabled: true, content: 'Reply as {{char}}.' }],
            },
            world_info_settings: { world_info: { globalSelect: [] }, world_info_depth: 2, world_info_budget: 25 },
            power_user: {
                sysprompt: { enabled: true, content: 'System for {{user}}.' },
                context: { story_string: '{{#if description}}{{description}}{{/if}}\n{{#if wiBefore}}{{wiBefore}}{{/if}}' },
                persona_description: 'A native user',
            },
            extension_settings: { regex: [] },
        },
        ...overrides,
    };
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('API v1 contracts', () => {
    test.each(['../secret', '/absolute', 'bad\\path', 'name/../../escape'])('rejects unsafe identifier %s', value => {
        expect(() => requireSafeId(value, 'characterId')).toThrow('not a valid identifier');
    });

    test('error body has stable fields', async () => {
        expect(errorBody('request-1', new Error('hidden')).error).toEqual({
            code: 'internal',
            message: 'An internal error occurred.',
            retryable: false,
            requestId: 'request-1',
        });
    });

    test('merge patch preserves unknown fields and deletes null keys', async () => {
        expect(mergePatch({ keep: 1, nested: { a: 1, b: 2 }, remove: true }, { nested: { b: 3 }, remove: null })).toEqual({
            keep: 1,
            nested: { a: 1, b: 3 },
        });
    });
});

describe('settings and cards', () => {
    test('settings patch preserves unknown keys on disk', async () => {
        const directories = makeDirectories();
        writeSettings(directories, { customFutureField: { keep: true }, username: 'Old' });
        const patched = patchSettings(directories, { username: 'New' });
        expect(patched.customFutureField).toEqual({ keep: true });
        expect(readSettings(directories).username).toBe('New');
    });

    test('normalizes Spec V2 character fields', async () => {
        const data = normalizeCharacterData({ name: 'Outer', data: { name: 'Inner', description: 'Lore' } });
        expect(data.name).toBe('Inner');
        expect(data.description).toBe('Lore');
    });
});

describe('headless prompt assembly', () => {
    test('expands macros, activates World Info, and applies regex', async () => {
        const session = makeSession();
        session.extensionSettings.regex = [{ findRegex: '/^Hello.*$/g', replaceString: 'Greetings', placement: [regex_placement.AI_OUTPUT], promptOnly: true }];
        fs.writeFileSync(path.join(session.directories.worlds, 'Contract.json'), JSON.stringify({
            entries: { lore: { id: 1, key: ['contract'], content: 'World lore for {{char}}.', order: 10, position: 0 } },
        }));
        session.settings.world_info_settings.world_info.globalSelect = ['Contract'];
        const character = {
            name: 'Aria',
            description: '{{char}} greets {{user}}.',
            personality: 'Kind',
            scenario: 'contract',
            first_mes: 'Hello Native User',
            mes_example: '<START>\n{{user}}: Hello\n{{char}}: Hi',
            character_book: null,
        };
        const chat = [{ name: 'Aria', is_user: false, mes: 'Hello contract', send_date: new Date().toISOString() }];
        const built = await buildPrompt(session, character, chat, { type: 'normal', input: 'Hello' });
        expect(built.messages[0].content).toContain('Reply as Aria.');
        expect(built.messages.some(message => message.content.includes('World lore for Aria.'))).toBe(true);
        expect(built.messages.at(-1).content).toBe('Greetings');
        expect(built.warnings.worldInfoActivated).toEqual(['Contract:1']);
        expect(built.providerRequest.custom_url).toBe('http://127.0.0.1:3999/v1');
    });

    test('rejects unsupported main APIs and providers', async () => {
        const session = makeSession();
        session.settings.main_api = 'novel';
        await expect(buildPrompt(session, { name: 'Aria' }, [], { type: 'normal' })).rejects.toThrow('not supported');
        session.settings.main_api = 'openai';
        session.settings.oai_settings.chat_completion_source = 'claude';
        await expect(buildPrompt(session, { name: 'Aria' }, [], { type: 'normal' })).rejects.toThrow('not supported');
    });

    test('global regex only runs at matching placement', async () => {
        const settings = { regex: [{ findRegex: '/a/g', replaceString: 'b', placement: [regex_placement.USER_INPUT] }] };
        const session = makeSession({ extensionSettings: settings });
        expect((await runNativeText(session, { name: 'Aria' }, [], { mode: 'append', message: { is_user: true, mes: 'a' } })).text).toBe('b');
        expect((await runNativeText(session, { name: 'Aria' }, [], { mode: 'output', text: 'a' })).text).toBe('a');
    });
});
