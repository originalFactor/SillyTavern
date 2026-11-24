import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { router } from '../dist/src/endpoints/api-v1.js';
import { cancel, clearGenerations, createGeneration } from '../dist/src/headless/generation-store.js';
import { readSettings, writeSettings } from '../dist/src/headless/session.js';
import { DEFAULT_USER, USER_DIRECTORY_TEMPLATE } from '../dist/src/constants.js';
import { serverDirectory } from '../dist/src/server-directory.js';
import { setConfigFilePath } from '../dist/src/util.js';

let root;
let directories;
let server;
let base;
const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '角色', description: 'A patient teacher.', first_mes: 'Hello {{user}}, I am {{char}}.', character_book: { entries: [] }, extensions: { future: { keep: [1, 2] } } }, vendor: { keep: 'opaque' } };

beforeAll(async () => {
    process.env.SILLYTAVERN_API_V1_ENABLED = 'true';
    setConfigFilePath(path.join(serverDirectory, 'default/config.yaml'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-character-management-'));
    directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([k, v]) => [k, path.join(root, v)]));
    for (const dir of Object.values(directories)) fs.mkdirSync(dir, { recursive: true });
    writeSettings(directories, { main_api: 'openai', username: 'Original User', futureField: { untouched: true }, oai_settings: { chat_completion_source: 'openai', openai_model: 'test-model' } });
    const app = express();
    app.use(express.json({ limit: '8mb' }));
    app.use((req, _res, next) => { req.user = { profile: { ...DEFAULT_USER, handle: 'management-user' }, directories }; next(); });
    app.use('/api/v1', router);
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

afterAll(async () => {
    clearGenerations();
    delete process.env.SILLYTAVERN_API_V1_ENABLED;
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
});

async function request(endpoint, method = 'GET', body) {
    const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
}

async function create(id, data = card) {
    const result = await request('/characters', 'POST', { characterId: id, card: data });
    expect(result.status).toBe(201);
    return result.body;
}

describe('native character management', () => {
    for (const [id, input] of [
        ['v1', { name: 'Legacy', description: 'Legacy data', unknown: { keep: true } }],
        ['v2', card],
        ['v3', { ...card, spec: 'chara_card_v3', spec_version: '3.0', data: { ...card.data, creator_notes_multilingual: { zh: '保留' } } }],
    ]) {
        test(`creates and exports ${id} without rewriting schema or dropping unknown fields`, async () => {
            const created = await create(id, input);
            expect(created.raw).toEqual(input);
            expect(created.revision).toMatch(/^[a-f0-9]{64}$/);
            const jsonExport = await request(`/characters/${id}/export?format=json`);
            expect(JSON.parse(Buffer.from(jsonExport.body.dataBase64, 'base64').toString())).toEqual(input);
            const png = await request(`/characters/${id}/export?format=png`);
            const imported = await request('/characters/import', 'POST', { characterId: `${id}-roundtrip`, format: 'png', dataBase64: png.body.dataBase64 });
            expect(imported.status).toBe(201);
            expect(imported.body.raw).toEqual(input);
        });
    }

    test('imports UTF-8 JSON, edits an exact revision, and rejects stale writes', async () => {
        const imported = await request('/characters/import', 'POST', { characterId: '导入角色', format: 'json', dataBase64: Buffer.from(JSON.stringify(card)).toString('base64') });
        expect(imported.status).toBe(201);
        expect((await request('/characters/%E5%AF%BC%E5%85%A5%E8%A7%92%E8%89%B2')).body.name).toBe('角色');
        const changed = { ...card, data: { ...card.data, name: 'Updated' } };
        const updated = await request('/characters/导入角色', 'PUT', { card: changed, expectedRevision: imported.body.revision });
        expect(updated.status).toBe(200);
        expect(updated.body.raw.vendor).toEqual(card.vendor);
        expect((await request('/characters/导入角色', 'PUT', { card, expectedRevision: imported.body.revision })).status).toBe(409);
        expect((await request('/characters/导入角色')).body.name).toBe('Updated');
        expect((await request('/characters', 'POST', { characterId: '导入角色', card })).status).toBe(409);
    });

    test('avatar replacement preserves the card and rejects stale or invalid writes', async () => {
        const created = await create('avatar-edit');
        const image = fs.readFileSync(path.join(serverDirectory, 'compat-source/upstream', 'img', 'user-default.png')).toString('base64');
        const endpoint = '/characters/avatar-edit/avatar';
        const updated = await request(endpoint, 'PUT', { expectedRevision: created.revision, dataBase64: image });
        expect(updated.status).toBe(200);
        expect(updated.body.raw).toEqual(card);
        expect(updated.body.revision).not.toBe(created.revision);
        expect((await request(endpoint, 'PUT', { expectedRevision: created.revision, dataBase64: image })).status).toBe(409);
        expect((await request(endpoint, 'PUT', { expectedRevision: updated.body.revision, dataBase64: Buffer.from('invalid').toString('base64') })).status).toBe(422);
        expect((await request('/characters/avatar-edit')).body).toMatchObject({ revision: updated.body.revision, raw: card });
    });

    test('malformed and unsupported imports do not publish a character', async () => {
        for (const body of [
            { characterId: 'invalid', format: 'png', dataBase64: Buffer.from('not png').toString('base64') },
            { characterId: 'invalid', format: 'json', dataBase64: '!!!!' },
            { characterId: '../escape', format: 'json', dataBase64: Buffer.from(JSON.stringify(card)).toString('base64') },
            { characterId: 'invalid', format: 'charx', dataBase64: 'AA==' },
        ]) expect((await request('/characters/import', 'POST', body)).status).toBeGreaterThanOrEqual(400);
        expect((await request('/characters/invalid')).status).toBe(404);
        expect(fs.existsSync(path.join(root, 'escape.png'))).toBe(false);
    });

    test('new chats expand the greeting and retain the character display name', async () => {
        await request('/characters/v2/chats', 'POST', { chatId: 'Greeting' });
        const chat = (await request('/chats/Greeting?characterId=v2')).body;
        expect(chat.messages[1].name).toBe('角色');
        expect(chat.messages[1].mes).toBe('Hello Original User, I am 角色.');
    });

    test('deletion requires the exact revision and explicit chat-deletion authorization', async () => {
        const c = await create('delete-me');
        expect((await request('/characters/delete-me/chats', 'POST', { chatId: 'Owned' })).status).toBe(201);
        expect((await request(`/characters/delete-me?expectedRevision=${c.revision}`, 'DELETE')).status).toBe(409);
        expect((await request('/characters/delete-me?deleteChats=true&expectedRevision=stale', 'DELETE')).status).toBe(409);
        expect(fs.existsSync(path.join(directories.chats, 'delete-me', 'Owned.jsonl'))).toBe(true);
        expect((await request(`/characters/delete-me?deleteChats=true&expectedRevision=${c.revision}`, 'DELETE')).status).toBe(200);
        expect((await request('/characters/delete-me')).status).toBe(404);
        expect(fs.existsSync(path.join(directories.chats, 'delete-me'))).toBe(false);
    });

    test('character changes are fenced by accepted generation admissions', async () => {
        const c = await create('active');
        const { record } = createGeneration({ handle: 'management-user', clientRequestId: 'active-card', characterId: 'active', chatId: 'new', type: 'normal', directories });
        try {
            expect((await request('/characters/active', 'PUT', { expectedRevision: c.revision, card })).status).toBe(409);
            const image = fs.readFileSync(path.join(serverDirectory, 'compat-source/upstream', 'img', 'user-default.png')).toString('base64');
            expect((await request('/characters/active/avatar', 'PUT', { expectedRevision: c.revision, dataBase64: image })).status).toBe(409);
            expect((await request(`/characters/active?deleteChats=true&expectedRevision=${c.revision}`, 'DELETE')).status).toBe(409);
        } finally { cancel(record, 'requested'); }
    });
});

describe('native personas', () => {
    test('saves, selects and edits a standard persona without overwriting unrelated settings', async () => {
        const before = (await request('/personas')).body;
        const saved = await request('/personas/learner.png', 'PUT', { expectedRevision: before.revision, name: '学习者', description: 'I enjoy physics.', title: 'Student', select: true });
        expect(saved.status).toBe(200);
        expect(saved.body.selectedId).toBe('learner.png');
        expect(fs.existsSync(path.join(directories.avatars, 'learner.png'))).toBe(true);
        const settings = readSettings(directories);
        expect(settings.username).toBe('学习者');
        expect(settings.user_avatar).toBe('learner.png');
        expect(settings.power_user.persona_description).toBe('I enjoy physics.');
        expect(settings.futureField).toEqual({ untouched: true });
        expect((await request('/personas/learner.png/select', 'POST', { expectedRevision: before.revision })).status).toBe(409);
        const changed = await request('/personas/learner.png', 'PUT', { expectedRevision: saved.body.revision, name: '学习者', description: 'Changed persona.' });
        expect(changed.status).toBe(200);
        expect(readSettings(directories).power_user.persona_description).toBe('Changed persona.');
    });

    test('persona selection affects prompt macros; depth and hidden placements are honored', async () => {
        let catalog = (await request('/personas')).body;
        let saved = await request('/personas/learner.png', 'PUT', { expectedRevision: catalog.revision, name: '学习者', description: 'Depth persona marker', position: 4, depth: 0, role: 1, select: true });
        expect(saved.status).toBe(200);
        const preview = await request('/generations/preview', 'POST', { characterId: 'v2', chatId: 'Persona Preview', input: 'Hello' });
        expect(preview.status).toBe(200);
        expect(preview.body.messages.at(-1)).toEqual({ role: 'user', content: 'Depth persona marker' });
        saved = await request('/personas/learner.png', 'PUT', { expectedRevision: saved.body.revision, name: '学习者', description: 'Hidden persona marker', position: 9, select: true });
        const hidden = await request('/generations/preview', 'POST', { characterId: 'v2', chatId: 'Persona Preview', input: 'Hello' });
        expect(JSON.stringify(hidden.body.messages)).not.toContain('Hidden persona marker');
        catalog = saved.body;
        expect((await request(`/personas/learner.png?expectedRevision=${catalog.revision}`, 'DELETE')).status).toBe(200);
        expect(readSettings(directories).username).toBe('User');
        expect((await request('/personas')).body.personas).toHaveLength(0);
    });

    test('persona revision ignores independent provider settings changes', async () => {
        const catalog = (await request('/personas')).body;
        await request('/settings', 'PATCH', { oai_settings: { openai_model: 'changed-model' } });
        const created = await request('/personas/test.png', 'PUT', { expectedRevision: catalog.revision, name: 'Test', description: '' });
        expect(created.status).toBe(200);
        expect(readSettings(directories).oai_settings.openai_model).toBe('changed-model');
    });

    test('legacy in-prompt placement is normalized and author-note placements can be selected', async () => {
        await request('/settings', 'PATCH', { power_user: { persona_descriptions: { 'test.png': { position: 1, connections: [{ keep: true }] } } } });
        const catalog = (await request('/personas')).body;
        expect(catalog.personas.find(p => p.id === 'test.png').position).toBe(0);
        const selected = await request('/personas/test.png/select', 'POST', { expectedRevision: catalog.revision });
        expect(selected.status).toBe(200);
        expect(readSettings(directories).power_user.persona_description_position).toBe(0);
        await request('/settings', 'PATCH', { power_user: { persona_descriptions: { 'test.png': { position: 2 } } } });
        const changed = (await request('/personas')).body;
        const authorNote = await request('/personas/test.png/select', 'POST', { expectedRevision: changed.revision });
        expect(authorNote.status).toBe(200);
        expect(readSettings(directories).power_user.persona_description_position).toBe(2);
        expect(readSettings(directories).power_user.persona_descriptions['test.png'].connections).toEqual([{ keep: true }]);
    });
});
