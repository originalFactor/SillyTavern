import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { setConfigFilePath } from '../dist/src/util.js';
import { readCharacterChatSnapshot, readTranscriptSnapshot } from '../dist/src/headless/chat-snapshot.js';
import { readGroupChatSnapshot } from '../dist/src/headless/group-management.js';
import { router } from '../dist/src/endpoints/api-v1.js';

let root, file, groupFile, session, server, base, previousEnabled;
beforeAll(async () => {
    setConfigFilePath(path.resolve('default/config.yaml'));
    previousEnabled = process.env.SILLYTAVERN_API_V1_ENABLED;
    process.env.SILLYTAVERN_API_V1_ENABLED = 'true';
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-snapshot-'));
    const directories = Object.fromEntries(['root', 'chats', 'groupChats', 'groups', 'characters'].map(key => [key, path.join(root, key)]));
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(path.join(directories.chats, 'ada'));
    fs.writeFileSync(path.join(directories.root, 'settings.json'), '{}');
    session = { directories, handle: 'snapshot-user' };
    file = path.join(directories.chats, 'ada', 'chat.jsonl');
    groupFile = path.join(directories.groupChats, 'shared.jsonl');
    fs.writeFileSync(path.join(directories.groups, 'team.json'), JSON.stringify({ name: 'Team', members: ['ada.png'], chats: ['shared'], chat_id: 'shared' }));
    const app = express();
    app.use((request, _response, next) => { request.user = { directories, profile: { handle: session.handle } }; next(); });
    app.use('/api/v1', router);
    server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
beforeEach(() => {
    fs.writeFileSync(file, [{ chat_metadata: { variables: { count: 7 }, vendor: { keep: true } }, opaqueHeader: true }, { name: 'Ada', mes: 'Raw {{user}}', extra: { reasoning: 'Untouched', invocation: { opaque: true } }, swipes: ['Raw {{user}}', 'Alternative'], swipe_id: 0 }].map(row => JSON.stringify(row)).join('\n'));
    fs.writeFileSync(groupFile, JSON.stringify({ name: 'Historical speaker', mes: 'Headerless group', extra: { keep: true } }));
});
afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (previousEnabled === undefined) delete process.env.SILLYTAVERN_API_V1_ENABLED; else process.env.SILLYTAVERN_API_V1_ENABLED = previousEnabled;
});

describe('complete read-only chat snapshots', () => {
    test('returns raw metadata and every message from one byte snapshot, without header rows or synthesized indexes', () => {
        const before = fs.readFileSync(file);
        const result = readCharacterChatSnapshot(session, 'ada', 'chat');
        expect(result).toEqual({ characterId: 'ada', chatId: 'chat', revision: crypto.createHash('sha256').update(before).digest('hex'), headerPresent: true, chatMetadata: { variables: { count: 7 }, vendor: { keep: true } }, messages: [{ name: 'Ada', mes: 'Raw {{user}}', extra: { reasoning: 'Untouched', invocation: { opaque: true } }, swipes: ['Raw {{user}}', 'Alternative'], swipe_id: 0 }] });
        expect(fs.readFileSync(file)).toEqual(before);
        const changed = before.toString().replace('Raw {{user}}', 'New'); fs.writeFileSync(file, changed);
        expect(readCharacterChatSnapshot(session, 'ada', 'chat').revision).not.toBe(result.revision);
    });
    test('does not clip at the native page size and accepts 10000 complete messages', () => {
        fs.writeFileSync(file, JSON.stringify({ chat_metadata: {} }) + '\n' + Array.from({ length: 10000 }, (_, index) => JSON.stringify({ mes: `${index}` })).join('\n'));
        const result = readCharacterChatSnapshot(session, 'ada', 'chat');
        expect(result.messages).toHaveLength(10000); expect(result.messages.at(-1).mes).toBe('9999');
        fs.appendFileSync(file, '\n{"mes":"extra"}');
        expect(() => readCharacterChatSnapshot(session, 'ada', 'chat')).toThrow('10000');
    });
    test.each(['', '{"mes":"missing header"}', '{"chat_metadata":null}', '{"chat_metadata":[]}', '{"chat_metadata":{},"mes":"not a header"}', '{"chat_metadata":{}}\n{"mes":"valid"}\nbroken', '{"chat_metadata":{}}\n[]', '{"chat_metadata":{}}\nnull', '{"chat_metadata":{}}\n{"chat_metadata":{}}'])('rejects invalid rows and headers without returning a truncated successful result (%s)', text => {
        fs.writeFileSync(file, text); const before = fs.readFileSync(file);
        expect(() => readCharacterChatSnapshot(session, 'ada', 'chat')).toThrow(/header|rows|metadata/);
        expect(fs.readFileSync(file)).toEqual(before);
    });
    test('rejects invalid UTF-8, oversized files, symlinks, directories and traversal without reading other resources', () => {
        fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x7b])); expect(() => readCharacterChatSnapshot(session, 'ada', 'chat')).toThrow('UTF-8');
        fs.truncateSync(file, 8 * 1024 * 1024 + 1); expect(() => readCharacterChatSnapshot(session, 'ada', 'chat')).toThrow('8 MiB');
        const link = path.join(session.directories.chats, 'ada', 'link.jsonl'); fs.symlinkSync(file, link);
        expect(() => readCharacterChatSnapshot(session, 'ada', 'link')).toThrow('safely');
        const linkedDirectory = path.join(session.directories.chats, 'linked'); fs.symlinkSync(path.dirname(file), linkedDirectory);
        expect(() => readCharacterChatSnapshot(session, 'linked', 'chat')).toThrow('directory');
        expect(() => readTranscriptSnapshot(root, session.directories.chats)).toThrow('regular file');
        expect(() => readTranscriptSnapshot(session.directories.chats, path.join(root, 'elsewhere'))).toThrow('path');
        expect(() => readCharacterChatSnapshot(session, '../ada', 'chat')).toThrow();
        expect(() => readCharacterChatSnapshot(session, 'ada', 'missing')).toThrow('not found');
    });
    test('authorizes group attachments and projects empty metadata for legacy headerless groups in memory only', async () => {
        const before = fs.readFileSync(groupFile);
        expect(await readGroupChatSnapshot(session, 'team', 'shared')).toMatchObject({ groupId: 'team', chatId: 'shared', headerPresent: false, chatMetadata: {}, messages: [{ name: 'Historical speaker', mes: 'Headerless group', extra: { keep: true } }] });
        expect(fs.readFileSync(groupFile)).toEqual(before);
        await expect(readGroupChatSnapshot(session, 'team', 'unattached')).rejects.toThrow('not attached');
        fs.writeFileSync(groupFile, ''); expect((await readGroupChatSnapshot(session, 'team', 'shared')).messages).toEqual([]);
    });
    test.each(['append', 'replace'])('rejects a concurrent %s instead of returning a stale or mixed successful read', mode => {
        const original = fs.readSync;
        let changed = false;
        const spy = jest.spyOn(fs, 'readSync').mockImplementation((...args) => {
            const count = original(...args);
            if (!changed) {
                changed = true;
                if (mode === 'append') fs.appendFileSync(file, '\n{"mes":"new"}');
                else { const replacement = file + '.replacement'; fs.writeFileSync(replacement, '{"chat_metadata":{}}'); fs.renameSync(replacement, file); }
            }
            return count;
        });
        try { expect(() => readCharacterChatSnapshot(session, 'ada', 'chat')).toThrow('Chat changed'); }
        finally { spy.mockRestore(); }
    });
    test('exposes implemented capability flags and scoped no-store GET routes with structured failures', async () => {
        const capabilities = await (await fetch(`${base}/capabilities`)).json();
        expect(capabilities.resources).toMatchObject({ chatSnapshot: true, groupChatSnapshot: true });
        expect(capabilities.features.groupChats).toBe(false);
        for (const [url, expected] of [['/chats/chat/snapshot?characterId=ada', { characterId: 'ada', headerPresent: true }], ['/groups/team/chats/shared/snapshot', { groupId: 'team', headerPresent: false }]]) {
            const response = await fetch(base + url); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
            expect(await response.json()).toMatchObject(expected);
        }
        expect((await fetch(`${base}/chats/chat/snapshot`)).status).toBe(400);
        expect((await fetch(`${base}/groups/team/chats/unattached/snapshot`)).status).toBe(404);
        fs.writeFileSync(file, '{"chat_metadata":{}}\ninvalid');
        const response = await fetch(`${base}/chats/chat/snapshot?characterId=ada`); expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ error: { code: 'storage', retryable: false } });
    });
});
