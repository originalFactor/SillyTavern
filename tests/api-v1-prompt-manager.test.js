import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { router } from '../src/endpoints/api-v1.js';
import { readSettings, writeSettings } from '../src/headless/session.js';
import { buildPrompt } from '../src/headless/prompt.js';
import { assembleManagedPrompt } from '../src/headless/prompt-manager.js';
import { setConfigFilePath } from '../src/util.js';
import { serverDirectory } from '../src/server-directory.js';

let root, server, base, session;
const prompts = [
    { identifier: 'main', role: 'system', content: 'Original {{CHAR}}', vendor: { keep: true } },
    { identifier: 'charDescription', marker: true },
    { identifier: 'chatHistory', marker: true },
    { identifier: 'custom', role: 'user', content: 'Custom for {{user}}', system_prompt: false },
    { identifier: 'jailbreak', role: 'system', content: 'End' },
];
const order = ['main', 'charDescription', 'chatHistory', 'custom', 'jailbreak'].map(identifier => ({ identifier, enabled: true }));
const oai = extra => ({ chat_completion_source: 'openai', openai_model: 'test', prompts, prompt_order: [{ character_id: 100001, order }], ...extra });
const assemble = (extra = {}, type = 'normal', character = {}) => assembleManagedPrompt(oai(extra), { charDescription: 'Description' }, [{ role: 'user', content: 'History' }], [], character, type, (text, original) => text.replace('{{original}}', original));

beforeAll(async () => {
    process.env.SILLYTAVERN_API_V1_ENABLED = 'true';
    setConfigFilePath(path.join(serverDirectory, 'default/config.yaml'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-prompt-manager-'));
    session = { directories: { root, worlds: path.join(root, 'worlds') }, userName: 'Reader', extensionSettings: {} };
    fs.mkdirSync(session.directories.worlds);
    writeSettings(session.directories, { main_api: 'openai', username: 'Reader', oai_settings: oai(), extension_settings: {}, power_user: { persona_description: '' } });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { directories: session.directories }; next(); });
    app.use('/api/v1', router);
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    base = `http://127.0.0.1:${server.address().port}/api/v1/prompt-manager`;
});
afterAll(async () => {
    delete process.env.SILLYTAVERN_API_V1_ENABLED;
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
});

async function read() { return (await fetch(base)).json(); }
async function save(body) {
    const response = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
}

describe('managed prompt assembly', () => {
    test('follows order, roles, disabled entries and history markers without duplicating story', async () => {
        expect(assemble().messages.map(item => item.content)).toEqual(['Original {{CHAR}}', 'Description', 'History', 'Custom for {{user}}', 'End']);
        const changed = [...order].reverse().map(entry => ({ ...entry, enabled: entry.identifier !== 'main' }));
        expect(assemble({ prompt_order: [{ character_id: 100001, order: changed }] }).messages.map(item => item.content)).toEqual(['End', 'Custom for {{user}}', 'History', 'Description']);
    });
    test('honors triggers, card overrides, original macro and forbid_overrides', async () => {
        const custom = prompts.map(prompt => prompt.identifier === 'custom' ? { ...prompt, injection_trigger: ['quiet'] } : prompt);
        expect(assemble({ prompts: custom }).messages.some(item => item.role === 'user' && item.content.startsWith('Custom'))).toBe(false);
        expect(assemble({ prompts: custom }, 'quiet').messages.some(item => item.content.startsWith('Custom'))).toBe(true);
        expect(assemble({}, 'normal', { system_prompt: 'Override: {{original}}' }).messages[0].content).toBe('Override: Original {{CHAR}}');
        expect(assemble({ prompts: prompts.map(prompt => ({ ...prompt, forbid_overrides: true })) }, 'normal', { system_prompt: 'Blocked' }).messages[0].content).toBe('Original {{CHAR}}');
    });
    test('depth zero is after history; deeper injections retain upstream priority and role grouping', async () => {
        const injected = [
            { identifier: 'a', role: 'system', content: 'At zero', injection_position: 1, injection_depth: 0 },
            { identifier: 'b', role: 'user', content: 'Before history', injection_position: 1, injection_depth: 1 },
            { identifier: 'c', role: 'assistant', content: 'Low priority', injection_position: 1, injection_depth: 0, injection_order: 200 },
        ];
        const result = assemble({ prompts: [...prompts, ...injected], prompt_order: [{ character_id: 100001, order: [...order, ...injected.map(prompt => ({ identifier: prompt.identifier, enabled: true }))] }] });
        expect(result.messages.map(item => item.content)).toEqual(['Original {{CHAR}}', 'Description', 'Before history', 'History', 'At zero', 'Low priority', 'Custom for {{user}}', 'End']);
    });
    test('depth Persona stays within history, while quiet instructions remain after post-history prompts', async () => {
        const settings = { ...readSettings(session.directories), oai_settings: oai(), power_user: { persona_description: 'Depth Persona', persona_description_position: 4, persona_description_depth: 0 } };
        const result = await buildPrompt({ ...session, settings }, { name: 'Aria' }, [{ is_user: true, mes: 'History' }], { type: 'quiet', input: 'Quiet last' });
        expect(result.messages.map(message => message.content)).toEqual(['Original Aria', 'History', 'Depth Persona', 'Custom for Reader', 'End', 'Quiet last']);
    });
    test('legacy global settings retain Persona descriptions when migrated to marker assembly', async () => {
        const settings = { ...readSettings(session.directories), oai_settings: oai({ prompt_order: [{ character_id: 100000, order }] }), power_user: { persona_description: 'Legacy Persona', persona_description_position: 0 } };
        const result = await buildPrompt({ ...session, settings }, { name: 'Aria', description: 'Description' }, [], { type: 'normal' });
        expect(result.messages.map(message => message.content)).toContain('Legacy Persona');
    });
    test('macro-prefixed dialogue examples use upstream named system messages', async () => {
        const exampleOrder = [...order, { identifier: 'dialogueExamples', enabled: true }];
        const settings = { ...readSettings(session.directories), oai_settings: oai({ prompt_order: [{ character_id: 100001, order: exampleOrder }] }), power_user: {} };
        const result = await buildPrompt({ ...session, settings }, { name: 'Aria', mes_example: '{{user}}: Hello\n{{char}}: Hi' }, [], { type: 'normal' });
        expect(result.messages.slice(-2)).toEqual([{ role: 'system', name: 'example_user', content: 'Hello' }, { role: 'system', name: 'example_assistant', content: 'Hi' }]);
    });
    test('100001 takes precedence over legacy order; unknown references are skipped like upstream', async () => {
        expect(assemble({ prompt_order: [{ character_id: 100000, order: [] }, { character_id: 100001, order: [...order, { identifier: 'missing', enabled: true }] }] }).messages).toHaveLength(5);
    });
    test('shared preview/dispatch builder expands case-insensitive character macros and leaves unsupported macros visible', async () => {
        session.settings = readSettings(session.directories);
        const result = await buildPrompt(session, { name: 'Aria', description: 'Description', system_prompt: '{{original}} / {{charIfNotGroup}} / {{getvar::unknown}} / {{unregisteredFixture}}' }, [{ is_user: true, mes: 'History' }], { type: 'normal' });
        expect(result.messages[0].content).toBe('Original Aria / Aria /  / {{unregisteredFixture}}');
        expect(result.messages.filter(item => item.content === 'Description')).toHaveLength(1);
        expect(result.warnings.promptManagerOrdering).toBe(true);
        expect(result.warnings.promptManagerPresets).toBe(false);
    });
});

describe('revision-checked native configuration', () => {
    test('writes only prompt fields, preserves opaque fields and rejects stale writes', async () => {
        const before = await read();
        const settings = readSettings(session.directories);
        settings.oai_settings.openai_model = 'independent-change';
        settings.oai_settings.prompt_order.push({ character_id: 'other', order: [] });
        writeSettings(session.directories, settings);
        const result = await save({ ...before, expectedRevision: before.revision, order: [...before.order].reverse() });
        expect(result.status).toBe(200);
        expect(result.body.prompts[0].vendor.keep).toBe(true);
        expect(readSettings(session.directories).oai_settings.openai_model).toBe('independent-change');
        expect(readSettings(session.directories).oai_settings.prompt_order.some(item => item.character_id === 'other')).toBe(true);
        expect((await save({ ...before, expectedRevision: before.revision })).status).toBe(409);
    });
    test.each([
        { prompts: [{ identifier: 'same' }, { identifier: 'same' }], order: [] },
        { prompts: [{ identifier: 'a', role: 'tool' }], order: [] },
        { prompts: [{ identifier: 'a', injection_depth: -1 }], order: [] },
        { prompts: [{ identifier: 'a', injection_trigger: ['unknown'] }], order: [] },
        { prompts: [{ identifier: 'a' }], order: [{ identifier: 'missing', enabled: true }] },
        { prompts: [{ identifier: 'a' }], order: [{ identifier: 'a', enabled: 'false' }] },
        { prompts: [{ identifier: 'chatHistory', injection_position: 1 }], order: [] },
    ])('rejects malformed native edits without changing disk', async invalid => {
        const before = await read();
        expect((await save({ ...invalid, expectedRevision: before.revision })).status).toBe(400);
        expect((await read()).revision).toBe(before.revision);
    });
});
