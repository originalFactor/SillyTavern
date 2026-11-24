import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';

import { createPluginContext, HEADLESS_EVENT_TYPES } from '../dist/src/headless/plugin-context.js';
import {
    applyHeadlessHooks,
    applyHeadlessOutputHooks,
    areHeadlessPluginHooksEnabled,
    emitHeadlessEvent,
    persistPluginSettings,
} from '../dist/src/headless/plugin-runtime.js';
import { buildPrompt } from '../dist/src/headless/prompt.js';
import { readSettings } from '../dist/src/headless/session.js';
import { restoreGenerations, persistGeneration, clearGenerations, createGeneration, getGeneration } from '../dist/src/headless/generation-store.js';
import { setConfigFilePath } from '../dist/src/util.js';
import { serverDirectory } from '../dist/src/server-directory.js';

const ORIGINAL_ENV = { ...process.env };
let root;
let directories;

function makeSession(overrides = {}) {
    return {
        handle: 'plugin-user',
        directories,
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
            world_info_settings: { world_info: { globalSelect: [] }, world_info_depth: 2 },
            power_user: {
                sysprompt: { enabled: true, content: 'System for {{user}}.' },
                context: { story_string: '{{description}}' },
                persona_description: 'A native user',
            },
            extension_settings: { regex: [], apiKey: 'DO-NOT-LEAK' },
        },
        ...overrides,
    };
}

/**
 * Installs a local headless extension with a given entry source.
 * @param {string} name Extension directory name
 * @param {string} source ESM source of index.mjs
 * @param {object} manifest Optional manifest overrides
 * @returns {string} Extension id
 */
function installExtension(name, source, manifest = {}) {
    const dir = path.join(directories.extensions, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.mjs'), source);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        display_name: name,
        version: '1.0.0',
        runtime: 'headless',
        entry: 'index.mjs',
        hooks: { beforePrompt: 'beforePrompt', afterPrompt: 'afterPrompt', onGenerationEvent: 'onGenerationEvent', afterGeneration: 'afterGeneration' },
        ...manifest,
    }));
    return `local/${name}`;
}

function builtPrompt() {
    return buildPrompt(makeSession(), {
        name: 'Aria', description: 'A character.', personality: '', scenario: '',
        first_mes: 'Hello', mes_example: '', character_book: null,
    }, [{ name: 'Aria', is_user: false, mes: 'Hello' }], { type: 'normal', input: '' });
}

beforeAll(() => {
    setConfigFilePath(path.join(serverDirectory, 'default', 'config.yaml'));
});

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-headless-plugin-'));
    directories = {
        root,
        extensions: path.join(root, 'extensions'),
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        worlds: path.join(root, 'worlds'),
    };
    for (const dir of Object.values(directories)) fs.mkdirSync(dir, { recursive: true });
    process.env.SILLYTAVERN_API_V1_HEADLESSPLUGINS = 'true';
});

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    clearGenerations();
    fs.rmSync(root, { recursive: true, force: true });
});

describe('plugin context shim', () => {
    test('exposes the ST global shape and redacts credentials', async () => {
        const { context } = createPluginContext({
            messages: [], settings: { apiKey: 'SECRET', nested: { token: 'X', keep: 1 } },
            extensionSettings: {}, generation: {},
        });
        expect(global.SillyTavern.getContext()).toBe(context);
        expect(context.settings.apiKey).toBeUndefined();
        expect(context.settings.nested.token).toBeUndefined();
        expect(context.settings.nested.keep).toBe(1);
        expect(context.eventTypes.MESSAGE_RECEIVED).toBe(HEADLESS_EVENT_TYPES.MESSAGE_RECEIVED);
    });

    test('collects settings writes, extension prompts and bounded events', async () => {
        const { context, effects } = createPluginContext({
            messages: [], settings: {}, extensionSettings: {}, generation: {},
        });
        context.writeExtensionField('demo', 'enabled', true);
        context.setExtensionPrompt('note', 'Remember this', 0, 2, 0);
        context.eventSource.emit(HEADLESS_EVENT_TYPES.MESSAGE_RECEIVED, { text: 'hi' });
        expect(effects.settingsPatch.demo.enabled).toBe(true);
        expect(effects.extensionPrompts[0].value).toBe('Remember this');
        expect(effects.events[0].data.text).toBe('hi');
        expect(context.getRequestHeaders()).toEqual({ 'Content-Type': 'application/json' });
    });

    test('rejects privileged generation APIs instead of faking them', async () => {
        const { context, effects } = createPluginContext({ messages: [], settings: {}, extensionSettings: {}, generation: {} });
        await expect(context.generate()).rejects.toThrow('not available');
        await expect(context.sendStreamingRequest()).rejects.toThrow('not available');
        context.addOneMessage({ mes: 'x' });
        expect(effects.warnings.some(w => w.includes('chat mutation'))).toBe(true);
    });
});

describe('headless hook runtime', () => {
    test('feature flag is off by default and on via env', async () => {
        delete process.env.SILLYTAVERN_API_V1_HEADLESSPLUGINS;
        expect(areHeadlessPluginHooksEnabled()).toBe(false);
        process.env.SILLYTAVERN_API_V1_HEADLESSPLUGINS = 'true';
        expect(areHeadlessPluginHooksEnabled()).toBe(true);
    });

    test('beforePrompt/afterPrompt message mutations are actually applied', async () => {
        installExtension('prompt-mutator', `
export async function beforePrompt(context) {
    context.messages.push({ role: 'system', content: 'HEADLESS-BEFORE' });
}
export async function afterPrompt(context) {
    context.messages.push({ role: 'system', content: 'HEADLESS-AFTER' });
}
`);
        const prompt = await builtPrompt();
        const { prompt: hooked, effects } = await applyHeadlessHooks(makeSession(), prompt, { characterId: 'Aria', chatId: 'Chat' });
        expect(hooked.messages.some(m => m.content === 'HEADLESS-BEFORE')).toBe(true);
        expect(hooked.messages.some(m => m.content === 'HEADLESS-AFTER')).toBe(true);
        expect(effects.warnings).toHaveLength(0);
    });

    test('setExtensionPrompt injects a bounded prompt into the built messages', async () => {
        installExtension('prompt-injector', `
export async function beforePrompt(context) {
    context.setExtensionPrompt('extra', 'INJECTED-LORE', 0, 0, 0);
}
`);
        const { prompt } = await applyHeadlessHooks(makeSession(), await builtPrompt(), {});
        expect(prompt.messages.some(m => m.content === 'INJECTED-LORE')).toBe(true);
    });

    test('plugin settings writes are persisted to user settings', async () => {
        installExtension('settings-writer', `
export async function beforePrompt(context) {
    context.writeExtensionFieldBulk('settings-writer', { enabled: true, count: 7 });
}
`);
        const { effects } = await applyHeadlessHooks(makeSession(), await builtPrompt(), {});
        expect(effects.settingsPatch['settings-writer'].count).toBe(7);
        persistPluginSettings(makeSession(), effects.settingsPatch);
        const stored = readSettings(directories);
        expect(stored.extension_settings['settings-writer']).toEqual({ enabled: true, count: 7 });
    });

    test('onGenerationEvent emits bounded plugin events', async () => {
        installExtension('event-emitter', `
export async function onGenerationEvent(context) {
    await context.eventSource.emit(context.eventTypes.MESSAGE_RECEIVED, { hello: 'world' });
}
`);
        const effects = await emitHeadlessEvent(makeSession(), 'generation_started', { requestId: 'r1' });
        expect(effects.events[0].data.hello).toBe('world');
        expect(effects.events[0].extensionId).toBe('local/event-emitter');
    });

    test('afterGeneration can transform the model output', async () => {
        installExtension('output-filter', `
export async function afterGeneration(context) {
    context.generation.text = context.generation.text.replace(/bad/g, 'good');
}
`);
        const result = await applyHeadlessOutputHooks(makeSession(), 'bad bad bad', {});
        expect(result.text).toBe('good good good');
    });

    test('an explicit returned output takes precedence over the unchanged generation field', async () => {
        installExtension('returned-output', 'export async function afterGeneration() { return "Returned output"; }');
        expect((await applyHeadlessOutputHooks(makeSession(), 'Original output')).text).toBe('Returned output');
    });

    test('a throwing hook degrades to a visible warning without breaking the turn', async () => {
        installExtension('broken', 'export async function beforePrompt() { throw new Error("boom"); }');
        const { prompt, effects } = await applyHeadlessHooks(makeSession(), await builtPrompt(), {});
        expect(prompt.messages.length).toBeGreaterThan(0);
        expect(effects.warnings.join(' ')).toContain('boom');
    });

    test('local extension entries resolve from the session directory, not the default user', async () => {
        installExtension('local-only', 'export async function beforePrompt(ctx) { ctx.messages.push({ role: "system", content: "LOCAL-OK" }); }');
        const session = makeSession({ directories: { ...directories, extensions: path.join(root, 'extensions') } });
        const { prompt, effects } = await applyHeadlessHooks(session, await builtPrompt(), {});
        expect(prompt.messages.some(m => m.content === 'LOCAL-OK')).toBe(true);
        expect(effects.warnings).toHaveLength(0);
    });
});

describe('generation journal', () => {
    test('in-flight records restore as unknown after a restart and are never replayed', async () => {
        const created = createGeneration({ handle: 'plugin-user', clientRequestId: 'journal-1', characterId: 'Aria', chatId: 'Chat', type: 'normal', directories });
        persistGeneration(directories, created.record);
        clearGenerations();
        const restored = restoreGenerations(directories);
        expect(restored).toBe(1);
        const record = getGeneration(created.record.requestId, 'plugin-user', directories);
        expect(record.status).toBe('unknown');
        expect(record.error.message).toContain('restart');
        expect(record.restored).toBe(true);
    });

    test('terminal records restore with their committed snapshot', async () => {
        const created = createGeneration({ handle: 'plugin-user', clientRequestId: 'journal-2', characterId: 'Aria', chatId: 'Chat', type: 'normal', directories });
        created.record.status = 'done';
        created.record.text = 'final text';
        created.record.committed = true;
        created.record.snapshot = { messageIndex: 4 };
        persistGeneration(directories, created.record);
        clearGenerations();
        restoreGenerations(directories);
        const record = getGeneration(created.record.requestId, 'plugin-user', directories);
        expect(record.status).toBe('done');
        expect(record.text).toBe('final text');
        expect(record.snapshot.messageIndex).toBe(4);
    });
});
