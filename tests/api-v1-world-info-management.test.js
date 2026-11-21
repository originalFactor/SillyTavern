import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { beforeAll, beforeEach, afterAll, describe, expect, test } from '@jest/globals';
import { router } from '../src/endpoints/api-v1.js';
import { clearGenerations, createGeneration } from '../src/headless/generation-store.js';
import { readSettings, writeSettings, writeChat, readChat } from '../src/headless/session.js';
import { setConfigFilePath } from '../src/util.js';
import { serverDirectory } from '../src/server-directory.js';
import { write as writeCard } from '../src/character-card-parser.js';

let root, directories, server, base;
const book = { name: '世界书', vendor: { opaque: true }, entries: { 7: { uid: 7, key: ['alpha'], content: 'World lore', constant: true, vendor: { preserve: 1 } } } };
const chatFile = () => path.join(directories.chats, 'Aria/Chat.jsonl');
beforeAll(async () => {
    process.env.SILLYTAVERN_API_V1_ENABLED = 'true';
    setConfigFilePath(path.join(serverDirectory, 'default/config.yaml'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-world-manager-'));
    directories = { root, worlds: path.join(root, 'worlds'), chats: path.join(root, 'chats'), characters: path.join(root, 'characters'), avatars: path.join(root, 'avatars'), groupChats: path.join(root, 'group-chats') };
    for (const dir of Object.values(directories)) fs.mkdirSync(dir, { recursive: true });
    const app = express(); app.use(express.json({ limit: '8mb' }));
    app.use((req, _res, next) => { req.user = { profile: { handle: 'world-manager' }, directories }; next(); });
    app.use('/api/v1', router);
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
beforeEach(() => {
    clearGenerations();
    for (const dir of [directories.worlds, directories.characters, directories.chats, directories.groupChats, path.join(root, 'api-v1-generations')]) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); }
    writeSettings(directories, { oai_settings: { custom_api_key: 'must-not-leak', custom_model: 'Independent' }, world_info_settings: { world_info: { globalSelect: [], charLore: [], vendor: 'keep' }, world_info_recursive: true, vendor: { keep: true } }, power_user: { personas: {}, persona_descriptions: {} } });
    writeChat(chatFile(), [{ chat_metadata: { variables: { keep: 3 } }, opaque: true }, { mes: 'History', is_user: true, vendor: 'keep' }]);
});
afterAll(async () => { clearGenerations(); delete process.env.SILLYTAVERN_API_V1_ENABLED; if (server) await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
async function req(route, method = 'GET', body) {
    const response = await fetch(base + route, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
}
const save = (name = 'Book', value = book, revision = null) => req('/world-info/' + encodeURIComponent(name), 'PUT', { expectedRevision: revision, book: value });
const remove = revision => req('/world-info/Book?expectedRevision=' + revision, 'DELETE');
describe('revision-checked native World Info management', () => {
    test('create/read/edit/export preserve opaque native entries and Unicode names', async () => {
        const created = await save('世界 书'); expect(created.status).toBe(200); expect(created.value.book).toEqual(book);
        const catalog = await req('/world-info'); expect(catalog.value.books).toEqual([{ name: '世界 书', bytes: expect.any(Number) }]);
        const changed = structuredClone(book); changed.entries[7].content = 'Edited';
        const updated = await save('世界 书', changed, created.value.revision); expect(updated.status).toBe(200); expect(updated.value.revision).not.toBe(created.value.revision);
        const exported = await req('/world-info/' + encodeURIComponent('世界 书') + '/export');
        expect(JSON.parse(Buffer.from(exported.value.dataBase64, 'base64'))).toEqual(changed);
        expect(JSON.stringify(catalog)).not.toContain('must-not-leak');
    });
    test('creates and stale updates never overwrite an existing book', async () => {
        const a = await save(); expect((await save()).status).toBe(409);
        expect((await save('Book', { ...book, name: 'changed' }, a.value.revision)).status).toBe(200);
        expect((await save('Book', book, a.value.revision)).status).toBe(409);
        expect((await remove(a.value.revision)).status).toBe(409);
    });
    test('settings revisions exclude providers, preserve unknown fields, validate every selected book', async () => {
        await save(); const before = (await req('/world-info-settings')).value;
        const settings = readSettings(directories); settings.oai_settings.custom_model = 'Changed independently'; writeSettings(directories, settings);
        before.settings.world_info.globalSelect = ['Book']; before.settings.world_info.charLore = [{ name: 'Aria', extraBooks: ['Book'], vendor: 9 }];
        const edited = await req('/world-info-settings', 'PUT', { expectedRevision: before.revision, settings: before.settings }); expect(edited.status).toBe(200);
        expect(readSettings(directories)).toMatchObject({ oai_settings: { custom_model: 'Changed independently' }, world_info_settings: { vendor: { keep: true }, world_info: { vendor: 'keep', globalSelect: ['Book'] } } });
        expect((await req('/world-info-settings', 'PUT', { expectedRevision: before.revision, settings: before.settings })).status).toBe(409);
        const fresh = edited.value; fresh.settings.world_info.globalSelect = ['Missing'];
        expect((await req('/world-info-settings', 'PUT', { expectedRevision: fresh.revision, settings: fresh.settings })).status).toBe(404);
    });
    test.each([{ world_info_depth: -1 }, { world_info_recursive: 1 }, { world_info_budget: 101 }, { world_info: { globalSelect: ['Book', 'Book'] } }, { world_info: { charLore: [{ name: '..', extraBooks: [] }] } }])('rejects invalid settings without writes: %j', async patch => {
        const before = (await req('/world-info-settings')).value;
        expect((await req('/world-info-settings', 'PUT', { expectedRevision: before.revision, settings: { ...before.settings, ...patch } })).status).toBe(400);
        expect((await req('/world-info-settings')).value).toEqual(before);
    });
    test('chat binding changes preserve history and unrelated metadata, with stale/active fencing', async () => {
        await save(); const route = '/chats/Chat/world-info?characterId=Aria'; const before = (await req(route)).value;
        const edited = await req(route, 'PUT', { expectedRevision: before.revision, name: 'Book' }); expect(edited.status).toBe(200);
        expect(readChat(chatFile())).toEqual([{ chat_metadata: { variables: { keep: 3 }, world_info: 'Book' }, opaque: true }, { mes: 'History', is_user: true, vendor: 'keep' }]);
        expect((await req(route, 'PUT', { expectedRevision: before.revision, name: '' })).status).toBe(409);
        createGeneration({ handle: 'world-manager', characterId: 'Aria', chatId: 'Chat', clientRequestId: 'active-world', type: 'normal', directories });
        expect((await req(route, 'PUT', { expectedRevision: edited.value.revision, name: '' })).status).toBe(409);
        expect((await req(route)).status).toBe(200);
    });
    test('Persona lorebook writes reach selected state and reject missing books', async () => {
        await save(); const before = (await req('/personas')).value;
        const response = await req('/personas/Owned.png', 'PUT', { expectedRevision: before.revision, name: 'Reader', description: 'Persona', lorebook: 'Book', select: true }); expect(response.status).toBe(200);
        expect(readSettings(directories).power_user.persona_description_lorebook).toBe('Book');
        expect((await req('/personas/Owned.png', 'PUT', { expectedRevision: response.value.revision, name: 'Reader', description: 'Persona', lorebook: 'Missing' })).status).toBe(404);
        const revision = (await req('/world-info/Book')).value.revision; expect((await remove(revision)).status).toBe(409);
    });
    test.each(['global', 'extra', 'persona', 'chat', 'group-chat', 'character'])('refuses deleting a referenced %s book', async scope => {
        const created = await save(); const s = readSettings(directories);
        if (scope === 'global') s.world_info_settings.world_info.globalSelect = ['Book'];
        if (scope === 'extra') s.world_info_settings.world_info.charLore = [{ name: 'Aria', extraBooks: ['Book'] }];
        if (scope === 'persona') s.power_user.persona_descriptions.unselected = { lorebook: 'Book' };
        writeSettings(directories, s);
        if (scope === 'group-chat') writeChat(path.join(directories.groupChats, 'Group.jsonl'), [{ chat_metadata: { world_info: 'Book' } }]);
        if (scope === 'chat') writeChat(chatFile(), [{ chat_metadata: { world_info: 'Book' } }]);
        if (scope === 'character') fs.writeFileSync(path.join(directories.characters, 'Aria.png'), writeCard(fs.readFileSync(path.join(serverDirectory, 'default/content/default_Seraphina.png')), JSON.stringify({ name: 'Aria', extensions: { world: 'Book' } }), { preserveSpec: true }));
        expect((await remove(created.value.revision)).status).toBe(409); expect((await req('/world-info/Book')).status).toBe(200);
    });
    test('deletes unbound books with exact revision and leaves unrelated files intact', async () => {
        const created = await save(); fs.writeFileSync(path.join(directories.worlds, 'Other.json'), JSON.stringify(book));
        expect((await remove(created.value.revision)).status).toBe(200); expect((await req('/world-info/Book')).status).toBe(404); expect(fs.existsSync(path.join(directories.worlds, 'Other.json'))).toBe(true);
    });
    test('malformed UTF-8, JSON, symlink and oversized documents never become authoritative empty books', async () => {
        const created = await save(); const file = path.join(directories.worlds, 'Book.json');
        for (const invalid of [Buffer.from('{broken'), Buffer.from([123, 34, 255]), Buffer.alloc(4_194_305, 32)]) { fs.writeFileSync(file, invalid); expect((await req('/world-info/Book')).status).toBe(422); expect((await save('Book', book, created.value.revision)).status).toBe(422); }
        fs.unlinkSync(file); fs.symlinkSync(path.join(root, 'settings.json'), file);
        expect((await req('/world-info/Book')).status).toBe(422); expect((await remove(created.value.revision)).status).toBe(422);
        expect((await req('/world-info')).value.warnings).toHaveLength(1);
    });
    test.each([{ entries: [] }, { entries: { 1: { content: 3 } } }, { entries: { 1: { content: 'valid', key: [3] } } }])('rejects malformed imports: %j', async value => { expect((await save('Book', value)).status).toBe(400); });
    test('corrupt reference data and settings fail closed on deletion or configuration changes', async () => {
        const created = await save(); fs.writeFileSync(chatFile(), 'malformed');
        expect((await remove(created.value.revision)).status).toBe(422);
        fs.writeFileSync(path.join(root, 'settings.json'), '{corrupt'); expect((await req('/world-info-settings')).status).toBe(422);
    });
});
