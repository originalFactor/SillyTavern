import { describe, expect, test } from '@jest/globals';
import { validateExtensionPromptInput } from '../dist/src/headless/extension-prompt-input.js';
import { createGeneration, clearGenerations } from '../dist/src/headless/generation-store.js';
const entry = { value: 'Injected', position: 1, depth: 0, scan: true, role: 0 };
describe('data-only native request extension prompts', () => {
    test('validates detached bounded entries and rejects executable/unknown data', () => {
        expect(validateExtensionPromptInput(undefined)).toBeUndefined();
        const input = { demo: { ...entry } }, value = validateExtensionPromptInput(input);
        input.demo.value = 'later'; expect(value.demo.value).toBe('Injected');
        for (const invalid of [null, [], { demo: { ...entry, filter: '() => true' } }, JSON.parse('{"__proto__":{}}'), { constructor: entry }, { demo: { ...entry, position: 3 } }, { demo: { ...entry, depth: 10001 } }, { demo: { ...entry, role: -1 } }, { demo: { ...entry, value: 2 } }, { demo: { ...entry, scan: 1 } }, Object.fromEntries(Array.from({ length: 129 }, (_, i) => [String(i), entry])), Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i), { ...entry, value: 'x'.repeat(65536) }]))]) expect(() => validateExtensionPromptInput(invalid)).toThrow('extensionPrompts');
    });
    test('caller identity includes injected content so a changed snapshot cannot reuse an admission', () => {
        clearGenerations();
        const base = { handle: 'prompt-test', clientRequestId: 'same-key', characterId: 'ada', chatId: 'chat', type: 'normal' };
        createGeneration({ ...base, requestIdentity: { extensionPrompts: { demo: entry } } });
        expect(() => createGeneration({ ...base, requestIdentity: { extensionPrompts: { demo: { ...entry, value: 'changed' } } } })).toThrow();
        clearGenerations();
    });
});

// Real V1 preview/admission/provider flow, independent of historical avatar assets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll } from '@jest/globals';
import { router } from '../dist/src/endpoints/api-v1.js';
import { USER_DIRECTORY_TEMPLATE } from '../dist/src/constants.js';
import { write as writePng } from '../dist/src/character-card-parser.js';
import { writeSettings } from '../dist/src/headless/session.js';
import { setConfigFilePath } from '../dist/src/util.js';
let root, directories, server, remote, base, requests = [], previousEnabled;
beforeAll(async () => {
    previousEnabled = process.env.SILLYTAVERN_API_V1_ENABLED;
    process.env.SILLYTAVERN_API_V1_ENABLED = 'true';
    setConfigFilePath(path.resolve('default/config.yaml'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-extension-prompt-input-'));
    directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, value)]));
    for (const dir of Object.values(directories)) fs.mkdirSync(dir, { recursive: true });
    const provider = express(); provider.use(express.json());
    provider.post('/v1/chat/completions', (req, res) => { requests.push(req.body); res.type('text/event-stream'); res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'Completed'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'); });
    remote = await new Promise(resolve => { const instance = provider.listen(0, '127.0.0.1', () => resolve(instance)); });
    const settings = { username: 'Reader', main_api: 'openai', power_user: {}, oai_settings: { chat_completion_source: 'custom', custom_url: `http://127.0.0.1:${remote.address().port}/v1`, custom_model: 'model', stream_openai: false, openai_max_context: 4096, openai_max_tokens: 100, prompts: [{ identifier: 'main', content: 'Main' }], prompt_order: [{ character_id: 100001, order: ['main', 'chatHistory'].map(identifier => ({ identifier, enabled: true })) }] } };
    writeSettings(directories, settings);
    const { writeSecret, SECRET_KEYS } = await import('../dist/src/endpoints/secrets.js'); writeSecret(directories, SECRET_KEYS.CUSTOM, 'private-prompt-test');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(path.join(directories.characters, 'ada.png'), writePng(png, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Ada', first_mes: 'Hello' } })));
    fs.mkdirSync(path.join(directories.chats, 'ada')); fs.writeFileSync(path.join(directories.chats, 'ada/chat.jsonl'), JSON.stringify({ chat_metadata: {} }) + '\n' + JSON.stringify({ name: 'Ada', is_user: false, mes: 'Hello' }));
    fs.writeFileSync(path.join(directories.groups, 'team.json'), JSON.stringify({ name: 'Team', members: ['ada.png'], disabled_members: [], chats: ['shared'], chat_id: 'shared', activation_strategy: 0, generation_mode: 0 }));
    fs.writeFileSync(path.join(directories.groupChats, 'shared.jsonl'), JSON.stringify({ chat_metadata: {} })+'\n'+JSON.stringify({ name: 'Reader', is_user: true, mes: 'Group question' }));
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { directories, profile: { handle: 'prompt-owner' } }; next(); }); app.use('/api/v1', router);
    server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); }); base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
afterAll(async () => {
    for (const instance of [server, remote]) if (instance) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); }
    clearGenerations(); if (root) fs.rmSync(root, { recursive: true, force: true });
    if (previousEnabled === undefined) delete process.env.SILLYTAVERN_API_V1_ENABLED; else process.env.SILLYTAVERN_API_V1_ENABLED = previousEnabled;
});
const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('V1 validates before admission, previews without dispatch and sends the captured injection once', async () => {
    const body = { characterId: 'ada', chatId: 'chat', clientRequestId: 'injection-key', type: 'normal', input: 'Question', stream: false, extensionPrompts: { demo: entry } };
    const before = fs.readFileSync(path.join(directories.chats, 'ada/chat.jsonl'), 'utf8');
    const invalid = await post('/generations', { ...body, extensionPrompts: { demo: { ...entry, filter: 'code' } } }); expect(invalid.status).toBe(400); expect(requests).toHaveLength(0);
    const preview = await post('/generations/preview', body); const previewBody = await preview.json(); expect({ status: preview.status, error: previewBody.error }).toEqual({ status: 200 });
    expect(previewBody.messages.some(row => row.content.includes('Injected'))).toBe(true);
    expect(requests).toHaveLength(0); expect(fs.readFileSync(path.join(directories.chats, 'ada/chat.jsonl'), 'utf8')).toBe(before);
    const accepted = await post('/generations', body); expect(accepted.status).toBe(202); const admission = await accepted.json();
    let outcome;
    for (let i = 0; i < 150; i++) {
        outcome = await (await fetch(`${base}/generations/${admission.requestId}`)).json();
        if (outcome.drained && ['done', 'error', 'unknown'].includes(outcome.status)) break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(outcome.status).toBe('done'); expect(requests).toHaveLength(1);
    expect(requests[0].messages.some(row => row.content.includes('Injected'))).toBe(true);
    expect(fs.readFileSync(path.join(directories.chats, 'ada/chat.jsonl'), 'utf8')).not.toContain('Injected');
    expect((await post('/generations', body)).status).toBe(202); expect(requests).toHaveLength(1);
    expect((await post('/generations', { ...body, extensionPrompts: { demo: { ...entry, value: 'Changed' } } })).status).toBe(409);
});


test('group preview forwards the same validated request injection into the selected member frame', async () => {
    const before = requests.length;
    const response = await post('/groups/team/chats/shared/preview', { characterId: 'ada', type: 'normal', extensionPrompts: { demo: { ...entry, role: 2, depth: 3 } } });
    const body = await response.json();
    expect({ status: response.status, error: body.error }).toEqual({ status: 200 });
    expect(body.messages.some(row => row.content.includes('Injected'))).toBe(true);
    expect(requests).toHaveLength(before);
});
