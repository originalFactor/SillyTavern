import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { router } from '../dist/src/endpoints/api-v1.js';
import { clearGenerations, createGeneration } from '../dist/src/headless/generation-store.js';
import { createMacroContext } from '../dist/src/headless/macros.js';
import { readChat, readSettings, writeChat, writeSettings } from '../dist/src/headless/session.js';
import { setConfigFilePath } from '../dist/src/util.js';
import { serverDirectory } from '../dist/src/server-directory.js';

let root, directories, server, base, session;
const local = '/chats/Chat/variables?characterId=Aria';
const global = '/macro-variables/global';
const chat = () => path.join(directories.chats, 'Aria/Chat.jsonl');
beforeAll(async () => {
    process.env.SILLYTAVERN_API_V1_ENABLED = 'true';
    setConfigFilePath(path.join(serverDirectory, 'default/config.yaml'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-macro-editor-'));
    directories = { root, chats: path.join(root, 'chats') };
    session = { handle: 'macro-editor', directories, userName: 'Reader', extensionSettings: {} };
    const app = express();
    app.use(express.json({ limit: '8mb' }));
    app.use((req, _res, next) => { req.user = { profile: { handle: session.handle }, directories }; next(); });
    app.use('/api/v1', router);
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
beforeEach(() => {
    clearGenerations();
    fs.rmSync(path.join(root, 'api-v1-generations'), { recursive: true, force: true });
    writeSettings(directories, { extension_settings: { variables: { global: { shared: 'old' }, vendor: 'keep' }, other: 'keep' }, power_user: { experimental_macro_engine: true, other: 'keep' }, oai_settings: { custom_url: 'http://127.0.0.1:1234', custom_api_key: 'must-not-leak' } });
    writeChat(chat(), [{ chat_metadata: { variables: { count: 3 }, other: 'keep' }, extraHeader: true }, { mes: 'Stored message', is_user: false, opaque: true }]);
});
afterAll(async () => {
    clearGenerations();
    delete process.env.SILLYTAVERN_API_V1_ENABLED;
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
});
async function request(endpoint, body) {
    const response = await fetch(base + endpoint, body === undefined ? {} : { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
}
const edit = (state, extra = {}) => ({ expectedRevision: state.revision, variables: state.variables, ...(state.experimental === undefined ? {} : { experimental: state.experimental }), ...extra });

describe('native macro variable management', () => {
    test('reads only variable state and engine, without provider settings or credentials', async () => {
        const all = await request(global);
        expect(all.status).toBe(200);
        expect(all.value).toEqual({ revision: expect.any(String), experimental: true, variables: { shared: 'old' } });
        const one = await request(local);
        expect(one.value).toEqual({ revision: expect.any(String), variables: { count: 3 } });
        expect(JSON.stringify([all, one])).not.toContain('must-not-leak');
    });
    test('global revisions exclude unrelated settings, which are merged rather than overwritten', async () => {
        const before = (await request(global)).value;
        const settings = readSettings(directories); settings.oai_settings.custom_model = 'Independent'; writeSettings(directories, settings);
        const saved = await request(global, edit(before, { variables: { shared: 'new', nested: { array: [1, false, null, '文字🙂'] } }, experimental: false }));
        expect(saved.status).toBe(200);
        expect(saved.value.revision).not.toBe(before.revision);
        expect(readSettings(directories)).toMatchObject({ power_user: { experimental_macro_engine: false, other: 'keep' }, oai_settings: { custom_model: 'Independent' }, extension_settings: { variables: { vendor: 'keep', global: { shared: 'new' } }, other: 'keep' } });
        session.settings = readSettings(directories);
        expect(createMacroContext(session, { name: 'Aria' }, readChat(chat())).expand('{{setvar::n::4}}{{incvar::n}}/{{getvar::n}}/{{decvar::n}}')).toBe('5/4/4');
    });
    test('stale global variable and engine edits are conflicts, never implicit overwrites', async () => {
        const before = (await request(global)).value;
        expect((await request(global, edit(before, { variables: { shared: 'changed' } }))).status).toBe(200);
        expect((await request(global, edit(before, { experimental: false }))).status).toBe(409);
        expect((await request(global)).value.variables.shared).toBe('changed');
        expect((await request(global)).value.experimental).toBe(true);
    });
    test('a captured admission keeps its engine while preparation reads the latest global variables', async () => {
        const captured = { ...session, settings: readSettings(directories) };
        const before = (await request(global)).value;
        expect((await request(global, edit(before, { experimental: false, variables: { shared: 'latest' } }))).status).toBe(200);
        const context = createMacroContext(captured, { name: 'Aria' }, readChat(chat()));
        expect(context.expand('{{setvar::n::4}}{{incvar::n}}/{{getvar::n}}/{{decvar::n}}/{{getglobalvar::shared}}')).toBe('5/5/4/latest');
        expect(readSettings(directories).power_user.experimental_macro_engine).toBe(false);
    });
    test('local replacement supports deletion, preserves latest transcript rows and unrelated metadata', async () => {
        const before = (await request(local)).value;
        const current = readChat(chat()); current.push({ mes: 'Independent row', is_user: true }); writeChat(chat(), current);
        expect((await request(local, edit(before, { variables: {} }))).status).toBe(200);
        const saved = readChat(chat());
        expect(saved[0]).toEqual({ chat_metadata: { other: 'keep', variables: {} }, extraHeader: true });
        expect(saved.slice(1)).toEqual(current.slice(1));
        expect((await request(local, edit(before, { variables: { count: 99 } }))).status).toBe(409);
    });
    test('macro-side mutations invalidate an inspected variable revision', async () => {
        const before = (await request(local)).value;
        const current = readChat(chat()); current[0].chat_metadata.variables.count++; writeChat(chat(), current);
        expect((await request(local, edit(before))).status).toBe(409);
        expect(readChat(chat())[0].chat_metadata.variables.count).toBe(4);
    });
    test('accepted generation fences chat edits even before provider execution', async () => {
        const before = (await request(local)).value;
        createGeneration({ handle: session.handle, characterId: 'Aria', chatId: 'Chat', clientRequestId: 'active', type: 'normal', directories });
        expect((await request(local, edit(before, { variables: { count: 5 } }))).status).toBe(409);
        expect(readChat(chat())[0].chat_metadata.variables.count).toBe(3);
        const globalBefore = (await request(global)).value;
        expect((await request(global, edit(globalBefore, { variables: { shared: 'later turns' } }))).status).toBe(200);
    });
    test.each([
        { variables: [] }, { variables: null }, { variables: 'text' },
        { experimental: 'false' }, { provider: 'must-not-apply' }, { expectedRevision: '' },
    ])('rejects malformed global edits: %j', async patch => {
        const before = (await request(global)).value;
        expect((await request(global, edit(before, patch))).status).toBe(patch.expectedRevision === '' ? 409 : 400);
        expect((await request(global)).value).toEqual(before);
    });
    test('rejects engine/global fields at the chat endpoint and preserves special variable names as data', async () => {
        const before = (await request(local)).value;
        expect((await request(local, edit(before, { experimental: false }))).status).toBe(400);
        const data = JSON.parse('{"__proto__":"safe","constructor":"also safe"}');
        expect((await request(local, edit(before, { variables: data }))).value.variables).toEqual(data);
        expect({}.safe).toBeUndefined();
    });
    test('missing/corrupt chat metadata is visible and never synthesized by editing', async () => {
        expect((await request('/chats/Missing/variables?characterId=Aria')).status).toBe(404);
        writeChat(chat(), [{ mes: 'Missing header', is_user: false }]);
        const before = fs.readFileSync(chat(), 'utf8');
        expect((await request(local)).status).toBe(422);
        expect(fs.readFileSync(chat(), 'utf8')).toBe(before);
        expect((await request('/chats/Chat/variables?characterId=..')).status).toBe(400);
    });
    test('oversized editor documents fail without changing existing variable state', async () => {
        const before = (await request(global)).value;
        const response = await request(global, edit(before, { variables: { huge: 'x'.repeat(7_340_032) } }));
        expect(response.status).toBe(422);
        expect((await request(global)).value).toEqual(before);
    });
    test('an invalid transcript line or UTF-8 sequence is never dropped by a variable save', async () => {
        const before = (await request(local)).value;
        const valid = fs.readFileSync(chat());
        for (const suffix of [Buffer.from('\n{invalid'), Buffer.from([10, 0xff])]) {
            const content = Buffer.concat([valid, suffix]);
            fs.writeFileSync(chat(), content);
            expect((await request(local, edit(before))).status).toBe(422);
            expect(fs.readFileSync(chat())).toEqual(content);
        }
    });
    test('an invalid stored variable container is not replaced with an empty editable state', async () => {
        const settings = readSettings(directories); settings.extension_settings.variables = 'corrupt'; writeSettings(directories, settings);
        expect((await request(global)).status).toBe(422);
        expect(readSettings(directories).extension_settings.variables).toBe('corrupt');
    });
    test('invalid settings JSON or UTF-8 is not replaced by merged defaults', async () => {
        const before = (await request(global)).value;
        const file = path.join(root, 'settings.json');
        for (const content of [Buffer.from('{invalid'), Buffer.from([0xff]), Buffer.from('{"oai_settings":"invalid"}')]) {
            fs.writeFileSync(file, content);
            expect((await request(global, edit(before))).status).toBe(422);
            expect((await request(global)).status).toBe(422);
            expect(fs.readFileSync(file)).toEqual(content);
        }
    });
});
