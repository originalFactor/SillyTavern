import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { router } from '../dist/src/endpoints/api-v1.js';
import { readSettings, writeSettings } from '../dist/src/headless/session.js';
import { USER_DIRECTORY_TEMPLATE } from '../dist/src/constants.js';
import { setConfigFilePath } from '../dist/src/util.js';

let root, directories, server, base, enabled;
beforeAll(async () => {
    enabled = process.env.SILLYTAVERN_API_V1_ENABLED;
    process.env.SILLYTAVERN_API_V1_ENABLED = 'true';
    setConfigFilePath(path.resolve('default/config.yaml'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-persona-identity-'));
    directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, value)]));
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.user = { directories, profile: { handle: 'persona-test' } }; next(); });
    app.use('/api/v1', router);
    server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
beforeEach(() => {
    writeSettings(directories, {
        username: 'Custom display name', user_avatar: 'reader.png',
        oai_settings: { openai_model: 'independent', openai_api_key: 'must-not-leak' },
        power_user: { personas: { 'reader.png': 'Reader' }, persona_descriptions: { 'reader.png': { description: 'Original', vendor: { keep: true } } } },
    });
    // Existing test-owned avatar avoids relying on absent historical SPA assets.
    fs.writeFileSync(path.join(directories.avatars, 'reader.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMfsAAAAASUVORK5CYII=', 'base64'));
});
afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (enabled === undefined) delete process.env.SILLYTAVERN_API_V1_ENABLED; else process.env.SILLYTAVERN_API_V1_ENABLED = enabled;
});
async function request(url = '/personas', method = 'GET', body) {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
}

describe('revision-bound native Persona display identity', () => {
    test('GET returns the active name independently of descriptor/account names without writing or exposing provider fields', async () => {
        const before = fs.readFileSync(path.join(directories.root, 'settings.json'));
        const { status, value } = await request();
        expect(status).toBe(200);
        expect(value).toMatchObject({ username: 'Custom display name', selectedId: 'reader.png', personas: [{ id: 'reader.png', name: 'Reader' }] });
        expect(Object.keys(value).sort()).toEqual(['personas', 'revision', 'selectedId', 'username']);
        expect(JSON.stringify(value)).not.toMatch(/must-not-leak|independent|persona-test/);
        expect(fs.readFileSync(path.join(directories.root, 'settings.json'))).toEqual(before);
    });
    test('name changes invalidate the Persona revision while provider-only edits do not', async () => {
        const first = (await request()).value;
        const settings = readSettings(directories);
        writeSettings(directories, { ...settings, oai_settings: { ...settings.oai_settings, openai_model: 'changed' } });
        expect((await request()).value.revision).toBe(first.revision);
        writeSettings(directories, { ...readSettings(directories), username: '新显示名' });
        const second = (await request()).value;
        expect(second.username).toBe('新显示名'); expect(second.revision).not.toBe(first.revision);
        const bytes = fs.readFileSync(path.join(directories.root, 'settings.json'));
        expect((await request('/personas/reader.png/select', 'POST', { expectedRevision: first.revision })).status).toBe(409);
        expect(fs.readFileSync(path.join(directories.root, 'settings.json'))).toEqual(bytes);
    });
    test('select, save and delete return the actual resulting active name', async () => {
        const first = (await request()).value;
        const selected = await request('/personas/reader.png/select', 'POST', { expectedRevision: first.revision });
        expect(selected.status).toBe(200); expect(selected.value.username).toBe('Reader');
        const saved = await request('/personas/reader.png', 'PUT', { expectedRevision: selected.value.revision, name: '新名字', description: 'Updated' });
        expect(saved.status).toBe(200); expect(saved.value.username).toBe('新名字');
        expect(readSettings(directories).power_user.persona_descriptions['reader.png'].vendor).toEqual({ keep: true });
        const deleted = await request(`/personas/reader.png?expectedRevision=${saved.value.revision}`, 'DELETE');
        expect(deleted.status).toBe(200); expect(deleted.value.username).toBe('User'); expect(deleted.value.personas).toEqual([]);
        expect(readSettings(directories).oai_settings.openai_model).toBe('independent');
    });
    test('keeps the configured display name even when no registered avatar is selected', async () => {
        writeSettings(directories, { ...readSettings(directories), user_avatar: '', username: '  Alias 😀  ' });
        expect((await request()).value).toMatchObject({ selectedId: '', username: '  Alias 😀  ' });
        writeSettings(directories, { ...readSettings(directories), username: '' });
        expect((await request()).value.username).toBe('User');
    });
});
