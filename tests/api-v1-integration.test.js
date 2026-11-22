import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';

import { router as apiV1Router } from '../src/endpoints/api-v1.js';
import { createGroupChat, deleteGroupChat, getGroup, loadGroupCharacters } from '../src/headless/group-management.js';
import { runGroupGeneration } from '../src/headless/group-runtime.js';
import { prepareProviderSession } from '../src/headless/provider.js';
import { cancel, clearGenerations, createGeneration, getGeneration, snapshot } from '../src/headless/generation-store.js';
import { readSettings, writeSettings } from '../src/headless/session.js';
import { write as writePngMetadata } from '../src/character-card-parser.js';
import { DEFAULT_USER, USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { serverDirectory } from '../src/server-directory.js';
import { setConfigFilePath } from '../src/util.js';

/** @type {string} */
let dataRoot;
/** @type {Record<string, string>} */
let directories;
/** @type {import('node:http').Server} */
let apiServer;
/** @type {import('node:http').Server} */
let mockServer;
/** @type {string} */
let baseUrl;
/** @type {string} */
let mockUrl;
/** @type {Array<Record<string, any>>} */
let providerRequests;
let groupToCancel;

beforeAll(async () => {
    process.env.SILLYTAVERN_API_V1_ENABLED = 'true';
    process.env.SILLYTAVERN_ALLOWKEYSEXPOSURE = 'false';
    setConfigFilePath(path.join(serverDirectory, 'default', 'config.yaml'));
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-api-v1-integration-'));
    directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(dataRoot, value)]));
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });

    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Aria',
        data: {
            name: 'Aria',
            description: 'Aria talks to {{user}}.',
            personality: 'Helpful',
            scenario: 'A contract test',
            first_mes: 'Hello {{user}}!',
            mes_example: '{{user}}: Hi\n{{char}}: Hello',
        },
    };
    const png = fs.readFileSync(path.join(serverDirectory, 'default', 'content', 'default_Seraphina.png'));
    fs.writeFileSync(path.join(directories.characters, 'Aria.png'), writePngMetadata(png, JSON.stringify(card)));
    fs.mkdirSync(path.join(directories.chats, 'Aria'), { recursive: true });
    fs.writeFileSync(path.join(directories.chats, 'Aria', 'Chat.jsonl'), JSON.stringify({ chat_metadata: {} }));

    mockServer = await startMockProvider();
    mockUrl = `http://127.0.0.1:${mockServer.address().port}/v1`;
    const defaultSettings = JSON.parse(fs.readFileSync(path.join(serverDirectory, 'default', 'content', 'settings.json'), 'utf8'));
    defaultSettings.username = 'Native User';
    defaultSettings.main_api = 'openai';
    defaultSettings.oai_settings.chat_completion_source = 'custom';
    defaultSettings.oai_settings.custom_model = 'mock-model';
    defaultSettings.oai_settings.custom_url = mockUrl;
    defaultSettings.oai_settings.stream_openai = true;
    writeSettings(directories, defaultSettings);

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((request, _response, next) => {
        request.user = { profile: { ...DEFAULT_USER, handle: 'contract-user' }, directories };
        next();
    });
    app.use('/api/v1', apiV1Router);
    apiServer = await listen(app);
    baseUrl = `http://127.0.0.1:${apiServer.address().port}`;
});

afterAll(async () => {
    clearGenerations();
    delete process.env.SILLYTAVERN_API_V1_ENABLED;
    await Promise.all([apiServer, mockServer].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('API v1 routes', () => {
    test('manual group input works when all member cards are missing', async () => {
        const groupFile = path.join(directories.groups, 'missing-members.json');
        const chatFile = path.join(directories.groupChats, 'missing-members-chat.jsonl');
        fs.writeFileSync(groupFile, JSON.stringify({ name: 'Missing', members: ['absent.png'], disabled_members: [], activation_strategy: 2, chats: ['missing-members-chat'], chat_id: 'missing-members-chat' }));
        fs.writeFileSync(chatFile, JSON.stringify({ chat_metadata: {} }));
        const request = { user: { profile: { ...DEFAULT_USER, handle: 'contract-user' }, directories }, headers: {} };
        const session = await prepareProviderSession(request);
        const record = createGeneration({ handle: session.handle, clientRequestId: 'missing-members-input', characterId: 'missing-members', chatId: 'missing-members-chat', type: 'normal', targetKind: 'group', directories }).record;
        await runGroupGeneration(request, session, record, { groupId: 'missing-members', chatId: 'missing-members-chat', input: 'Hello {{user}}', overrides: {} });
        expect(record.status).toBe('done');
        expect(fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse).at(-1).mes).toBe('Hello Native User');
        fs.unlinkSync(groupFile);
        fs.unlinkSync(chatFile);
    });

    test('manual group input applies macros when no member is activated', async () => {
        const groupFile = path.join(directories.groups, 'manual-input.json');
        const chatFile = path.join(directories.groupChats, 'manual-input-chat.jsonl');
        fs.writeFileSync(groupFile, JSON.stringify({ name: 'Manual', members: ['Aria.png'], disabled_members: [], activation_strategy: 2, chats: ['manual-input-chat'], chat_id: 'manual-input-chat' }));
        fs.writeFileSync(chatFile, JSON.stringify({ chat_metadata: {} }));
        const originalSettings = readSettings(directories);
        const settings = structuredClone(originalSettings);
        settings.extension_settings ??= {};
        settings.extension_settings.regex = [{ placement: [1], findRegex: '/Hello/g', replaceString: 'Welcome', trimStrings: [] }];
        writeSettings(directories, settings);
        const request = { user: { profile: { ...DEFAULT_USER, handle: 'contract-user' }, directories }, headers: {} };
        const session = await prepareProviderSession(request);
        const record = createGeneration({ handle: session.handle, clientRequestId: 'manual-input-test', characterId: 'manual-input', chatId: 'manual-input-chat', type: 'normal', targetKind: 'group', directories }).record;
        const start = providerRequests.length;
        await runGroupGeneration(request, session, record, { groupId: 'manual-input', chatId: 'manual-input-chat', input: 'Hello {{user}} {{setvar::visits::1}}', overrides: {} });
        expect(record.status).toBe('done');
        expect(providerRequests).toHaveLength(start);
        const chat = fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse);
        expect(chat.at(-1).mes).toBe('Welcome Native User ');
        expect(chat[0].chat_metadata.variables.visits).toBe('1');
        writeSettings(directories, originalSettings);
        fs.unlinkSync(groupFile);
        fs.unlinkSync(chatFile);
    });

    test('restores the group reference when deleting its chat file fails', async () => {
        const groupFile = path.join(directories.groups, 'delete-failure.json');
        const chatFile = path.join(directories.groupChats, 'delete-failure-chat.jsonl');
        fs.writeFileSync(groupFile, JSON.stringify({ name: 'Delete failure', members: ['Aria.png'], chats: ['delete-failure-chat'], chat_id: 'delete-failure-chat' }));
        fs.writeFileSync(chatFile, '{}\n');
        const session = { handle: 'contract-user', directories };
        const document = await getGroup(session, 'delete-failure');
        const unlink = fs.unlinkSync;
        const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(file => {
            if (file === chatFile) throw Object.assign(new Error('delete failure'), { code: 'EIO' });
            return unlink(file);
        });
        try {
            await expect(deleteGroupChat(session, 'delete-failure', 'delete-failure-chat', document.revision)).rejects.toThrow('delete failure');
        } finally {
            unlinkSpy.mockRestore();
        }
        const restored = await getGroup(session, 'delete-failure');
        expect(restored.group.chats).toEqual(['delete-failure-chat']);
        expect(restored.group.chat_id).toBe('delete-failure-chat');
        expect(fs.readFileSync(chatFile, 'utf8')).toBe('{}\n');
        fs.unlinkSync(chatFile);
        fs.unlinkSync(groupFile);
    });

    test('deletes an individual group chat only when its revision and references permit it', async () => {
        const groupFile = path.join(directories.groups, 'delete-one.json');
        const otherFile = path.join(directories.groups, 'delete-other.json');
        const chatFile = path.join(directories.groupChats, 'delete-one-chat.jsonl');
        fs.writeFileSync(groupFile, JSON.stringify({ name: 'Delete one', members: ['Aria.png'], chats: ['delete-one-chat'], chat_id: 'delete-one-chat' }));
        fs.writeFileSync(otherFile, JSON.stringify({ name: 'Other', members: ['Aria.png'], chats: ['delete-one-chat'], chat_id: 'delete-one-chat' }));
        fs.writeFileSync(chatFile, JSON.stringify({ chat_metadata: {} }));
        const document = await (await fetch(`${baseUrl}/api/v1/groups/delete-one`)).json();
        const endpoint = `${baseUrl}/api/v1/groups/delete-one/chats/delete-one-chat`;
        expect((await fetch(`${endpoint}?expectedRevision=stale`, { method: 'DELETE' })).status).toBe(409);
        expect((await fetch(`${endpoint}?expectedRevision=${document.revision}`, { method: 'DELETE' })).status).toBe(409);
        expect(fs.existsSync(chatFile)).toBe(true);
        fs.unlinkSync(otherFile);
        createGeneration({ handle: 'contract-user', characterId: 'another-group', chatId: 'delete-one-chat', clientRequestId: 'delete-active', type: 'normal', targetKind: 'group' });
        expect((await fetch(`${endpoint}?expectedRevision=${document.revision}`, { method: 'DELETE' })).status).toBe(409);
        expect(fs.existsSync(chatFile)).toBe(true);
        clearGenerations();
        const result = await fetch(`${endpoint}?expectedRevision=${document.revision}`, { method: 'DELETE' });
        expect(result.status).toBe(200);
        const updated = await result.json();
        expect(updated.group.chats).toEqual([]);
        expect(updated.group.chat_id).toBe('');
        expect(fs.existsSync(chatFile)).toBe(false);
        fs.unlinkSync(groupFile);
    });

    test('group chat creation preserves the descriptor when either file write fails', async () => {
        const groupFile = path.join(directories.groups, 'creation-failure.json');
        const chatFile = path.join(directories.groupChats, 'creation-failure-chat.jsonl');
        fs.writeFileSync(groupFile, JSON.stringify({ name: 'Failure test', members: ['Aria.png'], chats: [], chat_id: '' }));
        const session = { handle: 'contract-user', directories };
        const original = fs.readFileSync(groupFile, 'utf8');
        const { revision } = await getGroup(session, 'creation-failure');
        const open = fs.openSync;
        const openSpy = jest.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
            if (file === chatFile) throw Object.assign(new Error('disk failure'), { code: 'EIO' });
            return open(file, ...args);
        });
        try {
            await expect(createGroupChat(session, 'creation-failure', 'creation-failure-chat', revision)).rejects.toThrow('disk failure');
        } finally {
            openSpy.mockRestore();
        }
        expect(fs.readFileSync(groupFile, 'utf8')).toBe(original);
        expect(fs.existsSync(chatFile)).toBe(false);

        const write = fs.writeFileSync;
        const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation((file, data, ...args) => {
            if (typeof file === 'number') {
                write(file, 'partial');
                throw Object.assign(new Error('partial write'), { code: 'EIO' });
            }
            return write(file, data, ...args);
        });
        try {
            await expect(createGroupChat(session, 'creation-failure', 'creation-failure-chat', revision)).rejects.toThrow('partial write');
        } finally {
            writeSpy.mockRestore();
        }
        expect(fs.readFileSync(groupFile, 'utf8')).toBe(original);
        expect(fs.existsSync(chatFile)).toBe(false);

        const rename = fs.renameSync;
        const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            if (to === groupFile) throw Object.assign(new Error('descriptor failure'), { code: 'EIO' });
            return rename(from, to);
        });
        try {
            await expect(createGroupChat(session, 'creation-failure', 'creation-failure-chat', revision)).rejects.toThrow('descriptor failure');
        } finally {
            renameSpy.mockRestore();
        }
        expect(fs.readFileSync(groupFile, 'utf8')).toBe(original);
        expect(fs.existsSync(chatFile)).toBe(false);
        fs.unlinkSync(groupFile);
    });

    test('group generation API admits one durable request and returns its committed result', async () => {
        const groupFile = path.join(directories.groups, 'api-group.json');
        const chatFile = path.join(directories.groupChats, 'api-group-chat.jsonl');
        fs.writeFileSync(groupFile, JSON.stringify({ name: 'API group', members: ['Aria.png'], disabled_members: [], activation_strategy: 1, chats: ['api-group-chat'], chat_id: 'api-group-chat' }));
        fs.writeFileSync(chatFile, JSON.stringify({ chat_metadata: {} }));
        try {
            const url = `${baseUrl}/api/v1/groups/api-group/chats/api-group-chat/generations`;
            const send = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientRequestId: 'api-group-turn', input: 'Group API request' }) });
            const start = providerRequests.length;
            const first = await (await send()).json();
            const second = await (await send()).json();
            expect(second).toMatchObject({ requestId: first.requestId, idempotent: true });
            const result = await waitForGeneration(first.requestId);
            expect(result).toMatchObject({ status: 'done', targetKind: 'group', committed: true, groupProgress: { members: ['Aria.png'], completed: [{ member: 'Aria.png', messageIndex: 2 }] } });
            expect(providerRequests).toHaveLength(start + 1);
            expect(fs.readFileSync(chatFile, 'utf8')).toContain('Mock reply');
            for (const type of ['regenerate', 'continue']) {
                const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientRequestId: `api-group-${type}`, type }) });
                expect(response.status).toBe(202);
                expect((await waitForGeneration((await response.json()).requestId)).status).toBe('done');
            }
            const last = fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse).at(-1);
            expect(last.swipes).toEqual(['Mock replyMock reply']);
            const swipeUrl = `${baseUrl}/api/v1/groups/api-group/chats/api-group-chat/swipe`;
            const staleSwipe = await fetch(swipeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 2, swipeId: 0, expectedMessage: { ...last, mes: 'stale' } }) });
            expect(staleSwipe.status).toBe(409);
            const swipe = await fetch(swipeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 2, swipeId: 0, expectedMessage: { ...last, index: 2 } }) });
            expect(swipe.status).toBe(200);
            expect(fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse).at(-1)).toMatchObject({ mes: 'Mock replyMock reply', swipe_id: 0 });
            const invalidSwipe = await fetch(swipeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 2, swipeId: 9 }) });
            expect(invalidSwipe.status).toBe(400);
            const message = JSON.parse(fs.readFileSync(chatFile, 'utf8').split('\n').at(-1));
            const editUrl = `${baseUrl}/api/v1/groups/api-group/chats/api-group-chat/messages/edit`;
            const edit = expectedMessage => fetch(editUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 2, expectedMessage, text: 'Edited {{char}}' }) });
            expect((await edit({ ...message, mes: 'stale' })).status).toBe(409);
            expect((await edit({ ...message, index: 2 })).status).toBe(200);
            const edited = JSON.parse(fs.readFileSync(chatFile, 'utf8').split('\n').at(-1));
            expect(edited.mes).toBe('Edited Aria');
            expect(edited.swipes[0]).toBe('Edited Aria');
            const deleteUrl = `${baseUrl}/api/v1/groups/api-group/chats/api-group-chat/messages/delete`;
            const remove = expectedMessage => fetch(deleteUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 2, expectedMessage }) });
            expect((await remove({ ...message, mes: 'outdated' })).status).toBe(409);
            expect((await remove({ ...edited, index: 2 })).status).toBe(200);
            expect(fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse)).toHaveLength(2);
            const quiet = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientRequestId: 'api-group-quiet', type: 'quiet' }) });
            expect(quiet.status).toBe(422);
        } finally {
            fs.unlinkSync(groupFile);
            fs.unlinkSync(chatFile);
        }
    });
    test('cancelling a later group provider call preserves earlier replies', async () => {
        const secondCard = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Bob', description: 'Bob speaks second.' } };
        const png = fs.readFileSync(path.join(serverDirectory, 'default', 'content', 'default_Seraphina.png'));
        fs.writeFileSync(path.join(directories.characters, 'Bob.png'), writePngMetadata(png, JSON.stringify(secondCard)));
        const groupFile = path.join(directories.groups, 'cancel-group.json');
        const chatFile = path.join(directories.groupChats, 'cancel-chat.jsonl');
        fs.writeFileSync(groupFile, JSON.stringify({ name: 'Cancel group', members: ['Aria.png', 'Bob.png'], disabled_members: [], activation_strategy: 1, chats: ['cancel-chat'], chat_id: 'cancel-chat' }));
        fs.writeFileSync(chatFile, JSON.stringify({ chat_metadata: {} }));
        const request = { user: { profile: { ...DEFAULT_USER, handle: 'contract-user' }, directories }, headers: {} };
        const session = await prepareProviderSession(request);
        const record = createGeneration({ handle: session.handle, clientRequestId: 'cancel-group-test', characterId: 'cancel-group', chatId: 'cancel-chat', type: 'normal', targetKind: 'group', directories }).record;
        groupToCancel = record;
        try {
            await runGroupGeneration(request, session, record, { groupId: 'cancel-group', chatId: 'cancel-chat', input: 'Cancel second group reply', overrides: {} });
            expect(record).toMatchObject({ status: 'cancelled', cancelOutcome: 'unknown', committed: true, drained: true });
            expect(record.groupProgress.completed).toEqual([{ member: 'Aria.png', messageIndex: 2 }]);
            const chat = fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse);
            expect(chat.slice(1).map(message => message.mes)).toEqual(['Cancel second group reply', 'Mock reply']);
        } finally {
            groupToCancel = null;
            fs.unlinkSync(path.join(directories.characters, 'Bob.png'));
            fs.unlinkSync(groupFile);
            fs.unlinkSync(chatFile);
        }
    });
    test('group runtime retains earlier replies when a later provider stream is interrupted', async () => {
        const secondCard = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Bob', description: 'Bob speaks second.' } };
        const png = fs.readFileSync(path.join(serverDirectory, 'default', 'content', 'default_Seraphina.png'));
        fs.writeFileSync(path.join(directories.characters, 'Bob.png'), writePngMetadata(png, JSON.stringify(secondCard)));
        const groupFile = path.join(directories.groups, 'partial-group.json');
        const chatFile = path.join(directories.groupChats, 'partial-chat.jsonl');
        fs.writeFileSync(groupFile, JSON.stringify({ name: 'Partial group', members: ['Aria.png', 'Bob.png'], disabled_members: [], activation_strategy: 1, chats: ['partial-chat'], chat_id: 'partial-chat' }));
        fs.writeFileSync(chatFile, JSON.stringify({ chat_metadata: {} }));
        const request = { user: { profile: { ...DEFAULT_USER, handle: 'contract-user' }, directories }, headers: {} };
        const session = await prepareProviderSession(request);
        const record = createGeneration({ handle: session.handle, clientRequestId: 'partial-group-test', characterId: 'partial-group', chatId: 'partial-chat', type: 'normal', targetKind: 'group', directories }).record;
        const start = providerRequests.length;
        await runGroupGeneration(request, session, record, { groupId: 'partial-group', chatId: 'partial-chat', input: 'Interrupt second group reply', overrides: {} });
        expect(record.status).toBe('unknown');
        expect(record.committed).toBe(true);
        expect(record.groupProgress.completed).toEqual([{ member: 'Aria.png', messageIndex: 2 }]);
        expect(providerRequests).toHaveLength(start + 2);
        const chat = fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse);
        expect(chat.slice(1).map(message => message.mes)).toEqual(['Interrupt second group reply', 'Mock reply']);
        clearGenerations();
        const restored = getGeneration(record.requestId, session.handle, directories);
        expect(snapshot(restored)).toMatchObject({ status: 'unknown', committed: true, groupProgress: { members: ['Aria.png', 'Bob.png'], completed: [{ member: 'Aria.png', messageIndex: 2 }] } });
        expect(providerRequests).toHaveLength(start + 2);
        fs.unlinkSync(path.join(directories.characters, 'Bob.png'));
        fs.unlinkSync(groupFile);
        fs.unlinkSync(chatFile);
    });
    test('group regeneration exposes normal generation type to extension hooks', async () => {
        const extensionDir = path.join(directories.extensions, 'group-type-check');
        const groupFile = path.join(directories.groups, 'group-type-check.json');
        const chatFile = path.join(directories.groupChats, 'group-type-check-chat.jsonl');
        fs.mkdirSync(extensionDir, { recursive: true });
        fs.writeFileSync(path.join(extensionDir, 'manifest.json'), JSON.stringify({ display_name: 'Group type check', version: '1.0.0', runtime: 'headless', entry: 'index.mjs', hooks: { beforePrompt: 'beforePrompt', onGenerationEvent: 'onGenerationEvent', afterGeneration: 'afterGeneration' } }));
        fs.writeFileSync(path.join(extensionDir, 'index.mjs'), `
export async function onGenerationEvent(context) {
    if (context.generation.event === 'generation_started') await context.eventSource.emit(context.eventTypes.MESSAGE_RECEIVED, { hook: 'started', type: context.generation.type });
}
export async function beforePrompt(context) {
    await context.eventSource.emit(context.eventTypes.MESSAGE_RECEIVED, { hook: 'prompt', type: context.generation.type });
}
export async function afterGeneration(context) { return context.generation.type; }
`);
        fs.writeFileSync(groupFile, JSON.stringify({ name: 'Group', members: ['Aria.png'], disabled_members: [], activation_strategy: 1, chats: ['group-type-check-chat'], chat_id: 'group-type-check-chat' }));
        fs.writeFileSync(chatFile, [{ chat_metadata: {} }, { is_user: true, mes: 'Hello' }, { name: 'Aria', mes: 'Old reply', original_avatar: 'Aria.png', extra: { gen_id: 42 } }].map(row => JSON.stringify(row)).join('\n'));
        const previous = process.env.SILLYTAVERN_API_V1_HEADLESSPLUGINS;
        process.env.SILLYTAVERN_API_V1_HEADLESSPLUGINS = 'true';
        try {
            const request = { user: { profile: { ...DEFAULT_USER, handle: 'contract-user' }, directories }, headers: {} };
            const session = await prepareProviderSession(request);
            const record = createGeneration({ handle: session.handle, clientRequestId: 'group-type-check', characterId: 'group-type-check', chatId: 'group-type-check-chat', type: 'regenerate', targetKind: 'group', directories }).record;
            await runGroupGeneration(request, session, record, { groupId: 'group-type-check', chatId: 'group-type-check-chat', type: 'regenerate', overrides: {} });
            expect(record.status).toBe('done');
            expect(fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse).at(-1).mes).toBe('normal');
            expect(record.pluginEvents.filter(event => ['started', 'prompt'].includes(event.data.hook)).map(event => event.data.type)).toEqual(['normal', 'normal']);
        } finally {
            if (previous === undefined) delete process.env.SILLYTAVERN_API_V1_HEADLESSPLUGINS;
            else process.env.SILLYTAVERN_API_V1_HEADLESSPLUGINS = previous;
            fs.rmSync(extensionDir, { recursive: true, force: true });
            fs.unlinkSync(groupFile);
            fs.unlinkSync(chatFile);
        }
    });
    test('group regeneration keeps the old batch when no member can be activated', async () => {
        const groupFile = path.join(directories.groups, 'regen-no-members.json');
        const chatFile = path.join(directories.groupChats, 'regen-no-members-chat.jsonl');
        fs.writeFileSync(groupFile, JSON.stringify({ name: 'Group', members: ['Aria.png'], disabled_members: ['Aria.png'], activation_strategy: 1, chats: ['regen-no-members-chat'], chat_id: 'regen-no-members-chat' }));
        const original = [{ chat_metadata: {} }, { is_user: true, mes: 'Hello' }, { name: 'Aria', mes: 'Old reply', original_avatar: 'Aria.png', extra: { gen_id: 42 } }];
        const bytes = original.map(row => JSON.stringify(row)).join('\n');
        fs.writeFileSync(chatFile, bytes);
        const request = { user: { profile: { ...DEFAULT_USER, handle: 'contract-user' }, directories }, headers: {} };
        const session = await prepareProviderSession(request);
        const record = createGeneration({ handle: session.handle, clientRequestId: 'regen-no-members-test', characterId: 'regen-no-members', chatId: 'regen-no-members-chat', type: 'regenerate', targetKind: 'group', directories }).record;
        try {
            const start = providerRequests.length;
            await runGroupGeneration(request, session, record, { groupId: 'regen-no-members', chatId: 'regen-no-members-chat', type: 'regenerate', overrides: {} });
            expect(record).toMatchObject({ status: 'done', committed: false, groupProgress: { members: [], completed: [] } });
            expect(fs.readFileSync(chatFile, 'utf8')).toBe(bytes);
            expect(providerRequests).toHaveLength(start);
        } finally {
            fs.unlinkSync(groupFile);
            fs.unlinkSync(chatFile);
        }
    });
    test('group regeneration preserves the old batch when the first provider stream fails', async () => {
        const groupFile = path.join(directories.groups, 'regen-first-failure.json');
        const chatFile = path.join(directories.groupChats, 'regen-first-failure-chat.jsonl');
        fs.writeFileSync(groupFile, JSON.stringify({ name: 'Group', members: ['Aria.png'], disabled_members: [], activation_strategy: 1, chats: ['regen-first-failure-chat'], chat_id: 'regen-first-failure-chat' }));
        const original = [{ chat_metadata: {} }, { is_user: true, mes: 'Truncated outcome' }, { name: 'Aria', mes: 'Old reply', original_avatar: 'Aria.png', extra: { gen_id: 42 } }];
        fs.writeFileSync(chatFile, original.map(row => JSON.stringify(row)).join('\n'));
        const request = { user: { profile: { ...DEFAULT_USER, handle: 'contract-user' }, directories }, headers: {} };
        const session = await prepareProviderSession(request);
        const record = createGeneration({ handle: session.handle, clientRequestId: 'regen-first-failure-test', characterId: 'regen-first-failure', chatId: 'regen-first-failure-chat', type: 'regenerate', targetKind: 'group', directories }).record;
        try {
            const start = providerRequests.length;
            await runGroupGeneration(request, session, record, { groupId: 'regen-first-failure', chatId: 'regen-first-failure-chat', type: 'regenerate', overrides: {} });
            expect(record).toMatchObject({ status: 'unknown', committed: false, groupProgress: { members: ['Aria.png'], completed: [] } });
            expect(fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse)).toEqual(original);
            clearGenerations();
            expect(snapshot(getGeneration(record.requestId, session.handle, directories))).toMatchObject({ status: 'unknown', committed: false, groupProgress: { completed: [] } });
            expect(providerRequests).toHaveLength(start + 1);
        } finally {
            fs.unlinkSync(groupFile);
            fs.unlinkSync(chatFile);
        }
    });
    test('group regeneration retains the first replacement when the second provider stream fails', async () => {
        const png = fs.readFileSync(path.join(serverDirectory, 'default', 'content', 'default_Seraphina.png'));
        const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Bob' } };
        const bobFile = path.join(directories.characters, 'Bob.png');
        const groupFile = path.join(directories.groups, 'regen-partial.json');
        const chatFile = path.join(directories.groupChats, 'regen-partial-chat.jsonl');
        fs.writeFileSync(bobFile, writePngMetadata(png, JSON.stringify(card)));
        fs.writeFileSync(groupFile, JSON.stringify({ name: 'Group', members: ['Aria.png', 'Bob.png'], disabled_members: [], activation_strategy: 1, chats: ['regen-partial-chat'], chat_id: 'regen-partial-chat' }));
        const original = [{ chat_metadata: {} }, { is_user: true, mes: 'Interrupt second group reply' },
            { name: 'Aria', mes: 'Old Aria', original_avatar: 'Aria.png', extra: { gen_id: 42 } },
            { name: 'Bob', mes: 'Old Bob', original_avatar: 'Bob.png', extra: { gen_id: 42 } }];
        fs.writeFileSync(chatFile, original.map(row => JSON.stringify(row)).join('\n'));
        const request = { user: { profile: { ...DEFAULT_USER, handle: 'contract-user' }, directories }, headers: {} };
        const session = await prepareProviderSession(request);
        const record = createGeneration({ handle: session.handle, clientRequestId: 'regen-partial-test', characterId: 'regen-partial', chatId: 'regen-partial-chat', type: 'regenerate', targetKind: 'group', directories }).record;
        try {
            const start = providerRequests.length;
            await runGroupGeneration(request, session, record, { groupId: 'regen-partial', chatId: 'regen-partial-chat', type: 'regenerate', overrides: {} });
            expect(record).toMatchObject({ status: 'unknown', committed: true, groupProgress: { members: ['Aria.png', 'Bob.png'], completed: [{ member: 'Aria.png', messageIndex: 2 }] } });
            const chat = fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse);
            expect(chat.slice(1).map(row => row.mes)).toEqual(['Interrupt second group reply', 'Mock reply']);
            expect(chat[2].extra.gen_id).not.toBe(42);
            clearGenerations();
            expect(snapshot(getGeneration(record.requestId, session.handle, directories))).toMatchObject({ status: 'unknown', committed: true, groupProgress: { completed: [{ member: 'Aria.png', messageIndex: 2 }] } });
            expect(providerRequests).toHaveLength(start + 2);
        } finally {
            fs.unlinkSync(bobFile);
            fs.unlinkSync(groupFile);
            fs.unlinkSync(chatFile);
        }
    });
    test('group runtime generates and commits speakers sequentially', async () => {
        const secondCard = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Bob', description: 'Bob is the second speaker.' } };
        const png = fs.readFileSync(path.join(serverDirectory, 'default', 'content', 'default_Seraphina.png'));
        fs.writeFileSync(path.join(directories.characters, 'Bob.png'), writePngMetadata(png, JSON.stringify(secondCard)));
        fs.writeFileSync(path.join(directories.groups, 'runtime-group.json'), JSON.stringify({ name: 'Runtime group', members: ['Aria.png', 'Bob.png'], disabled_members: [], activation_strategy: 1, chats: ['runtime-chat'], chat_id: 'runtime-chat' }));
        const chatFile = path.join(directories.groupChats, 'runtime-chat.jsonl');
        fs.writeFileSync(chatFile, JSON.stringify({ chat_metadata: { messenger_sampling: { temperature: 0.35, maxTokens: 48 } } }));
        const request = { user: { profile: { ...DEFAULT_USER, handle: 'contract-user' }, directories }, headers: {} };
        const session = await prepareProviderSession(request);
        const record = createGeneration({ handle: session.handle, clientRequestId: 'runtime-group-test', characterId: 'runtime-group', chatId: 'runtime-chat', type: 'normal', targetKind: 'group', directories }).record;
        const start = providerRequests.length;
        await runGroupGeneration(request, session, record, { groupId: 'runtime-group', chatId: 'runtime-chat', input: 'Hello group', overrides: {} });
        expect(record.status).toBe('done');
        expect(providerRequests).toHaveLength(start + 2);
        expect(providerRequests[start]).toMatchObject({ temperature: 0.35, max_tokens: 48 });
        expect(providerRequests[start + 1]).toMatchObject({ temperature: 0.35, max_tokens: 48 });
        const chat = fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse);
        expect(chat.slice(1).map(message => message.mes)).toEqual(['Hello group', 'Mock reply', 'Mock reply']);
        expect(chat.slice(2).map(message => message.original_avatar)).toEqual(['Aria.png', 'Bob.png']);
        expect(record.groupProgress.completed.map(item => item.messageIndex)).toEqual([2, 3]);
        expect(providerRequests[start + 1].messages.some(message => message.content?.includes('Mock reply'))).toBe(true);
        for (const type of ['regenerate', 'continue']) {
            const next = createGeneration({ handle: session.handle, clientRequestId: `runtime-group-${type}`, characterId: 'runtime-group', chatId: 'runtime-chat', type, targetKind: 'group', directories }).record;
            await runGroupGeneration(request, session, next, { groupId: 'runtime-group', chatId: 'runtime-chat', type, input: '', overrides: {} });
            expect(next.status).toBe('done');
        }
        const revised = fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse).at(-1);
        expect(revised.original_avatar).toBe('Bob.png');
        expect(revised.swipes).toEqual(['Mock replyMock reply']);
        expect(revised.swipe_id).toBe(0);
        const regeneratedChat = fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse);
        expect(regeneratedChat).toHaveLength(4);
        expect(regeneratedChat.slice(2).map(message => message.original_avatar)).toEqual(['Aria.png', 'Bob.png']);
        expect(regeneratedChat[2].extra.gen_id).toBe(regeneratedChat[3].extra.gen_id);
        fs.unlinkSync(path.join(directories.characters, 'Bob.png'));
        fs.unlinkSync(path.join(directories.groups, 'runtime-group.json'));
        fs.unlinkSync(chatFile);
    });
    test('legacy group sampling survives generation and preserves original messages', async () => {
        const groupFile = path.join(directories.groups, 'legacy-sampling.json');
        const chatFile = path.join(directories.groupChats, 'legacy-sampling-chat.jsonl');
        const greeting = { name: 'Aria', original_avatar: 'Aria.png', is_user: false, mes: 'Legacy greeting' };
        fs.writeFileSync(groupFile, JSON.stringify({ name: 'Legacy', members: ['Aria.png'], disabled_members: [], activation_strategy: 1, chats: ['legacy-sampling-chat'], chat_id: 'legacy-sampling-chat' }));
        fs.writeFileSync(chatFile, JSON.stringify(greeting));
        const url = `${baseUrl}/api/v1/groups/legacy-sampling/chats/legacy-sampling-chat/sampling`;
        try {
            const initial = await (await fetch(url)).json();
            const saved = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: initial.revision, overrides: { temperature: 0.45 } }) });
            expect(saved.status).toBe(200);
            const start = providerRequests.length;
            const generation = await fetch(`${baseUrl}/api/v1/groups/legacy-sampling/chats/legacy-sampling-chat/generations`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientRequestId: 'legacy-sampling-turn', input: 'Hello' }),
            });
            expect(generation.status).toBe(202);
            expect((await waitForGeneration((await generation.json()).requestId)).status).toBe('done');
            expect(providerRequests[start].temperature).toBe(0.45);
            const rows = fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse);
            expect(rows[0].chat_metadata.messenger_sampling).toEqual({ temperature: 0.45 });
            expect(rows[1]).toEqual(greeting);
            expect(rows.slice(2).map(row => row.mes)).toEqual(['Hello', 'Mock reply']);
        } finally {
            fs.rmSync(groupFile, { force: true });
            fs.rmSync(chatFile, { force: true });
        }
    });
    test('loads group member cards while skipping missing members', async () => {
        const session = { directories };
        const members = await loadGroupCharacters(session, { members: ['Aria.png'] });
        expect(members).toHaveLength(1);
        expect(members[0]).toMatchObject({ name: 'Aria', avatar: 'Aria.png', data: { name: 'Aria' } });
        expect(await loadGroupCharacters(session, { members: ['missing.png', 'Aria.png'] })).toMatchObject([{ avatar: 'Aria.png' }]);
        const corruptFile = path.join(directories.characters, 'corrupt-group-member.png');
        fs.writeFileSync(corruptFile, 'invalid card');
        try {
            await expect(loadGroupCharacters(session, { members: ['corrupt-group-member.png'] })).rejects.toMatchObject({ status: 422 });
        } finally {
            fs.unlinkSync(corruptFile);
        }
    });
    test('capabilities advertise unsupported features as false', async () => {
        const response = await fetch(`${baseUrl}/api/v1/capabilities`);
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body.version).toBe('1.0.0');
        expect(body.generation.regenerate).toBe(true);
        expect(body.generation.continue).toBe(true);
        expect(body.generation.restoreAfterRestart).toBe(true);
        expect(body.resources.chatCreate).toBe(true);
        expect(body.resources.chatPaging).toBe(true);
        expect(body.resources.chatRename).toBe(true);
        expect(body.resources.providerCredentials).toBe(true);
        expect(body.resources.groups).toBe(true);
        expect(body.resources.groupManagement).toBe(true);
        expect(body.resources.groupChatPaging).toBe(true);
        expect(body.resources.groupChatPreview).toBe(true);
        expect(body.generation.groupNormal).toBe(true);
        expect(body.generation.groupRegenerate).toBe(true);
        expect(body.generation.groupContinue).toBe(true);
        expect(body.providers.chatCompletionsOpenAI).toBe(true);
        expect(body.providers.chatCompletionsOpenAICompatible).toBe(true);
        expect(body.providers.textCompletionSources).toEqual(['generic', 'vllm', 'ooba', 'aphrodite', 'tabby', 'koboldcpp']);
        expect(body.features.textCompletionRequests).toBe(true);
        expect(body.providers.otherChatCompletionSources).toBe(false);
        expect(body.features.serverPlugins).toBe(false);
        expect(body.features.swipes).toBe(true);
        expect(body.features.upstreamMacroEngine).toBe(true);
        expect(body.features.advancedMacros).toBe(false);
    });

    test('creates and revision-checks native groups and their independent chats', async () => {
        const created = await fetch(`${baseUrl}/api/v1/groups`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: 'contract-group', group: {
                name: 'Contract Group', members: ['Aria.png'], disabled_members: ['Aria.png'],
                activation_strategy: 1, generation_mode: 0, chats: ['contract-group-chat'],
                chat_id: 'contract-group-chat', allow_self_responses: false,
            } }),
        });
        expect(created.status).toBe(201);
        const document = await created.json();
        expect(document.group.members).toEqual(['Aria.png']);
        expect(document.group.disabled_members).toEqual(['Aria.png']);
        expect(document.revision).toHaveLength(64);

        const newChat = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: 'contract-created-chat', expectedRevision: document.revision }),
        });
        expect(newChat.status).toBe(201);
        const updated = await newChat.json();
        expect(updated.group.chat_id).toBe('contract-created-chat');
        fs.unlinkSync(path.join(directories.groupChats, 'contract-created-chat.jsonl'));
        const recovered = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: 'contract-created-chat', expectedRevision: updated.revision }),
        });
        expect(recovered.status).toBe(201);
        const previewFile = path.join(directories.groupChats, 'contract-created-chat.jsonl');
        const samplingUrl = `${baseUrl}/api/v1/groups/contract-group/chats/contract-created-chat/sampling`;
        const samplingInitial = await (await fetch(samplingUrl)).json();
        const samplingBody = { expectedRevision: samplingInitial.revision, overrides: { temperature: 0.35, maxTokens: 48 } };
        const samplingSaved = await fetch(samplingUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(samplingBody) });
        expect(samplingSaved.status).toBe(200);
        const staleSampling = await fetch(samplingUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(samplingBody) });
        expect(staleSampling.status).toBe(409);
        const sharedGroupFile = path.join(directories.groups, 'sampling-shared.json');
        fs.writeFileSync(sharedGroupFile, JSON.stringify({ name: 'Shared', members: ['Aria.png'], disabled_members: [], activation_strategy: 1, chats: ['contract-created-chat'], chat_id: 'contract-created-chat' }));
        try {
            const sharedUrl = `${baseUrl}/api/v1/groups/sampling-shared/chats/contract-created-chat/sampling`;
            const shared = await (await fetch(sharedUrl)).json();
            expect(shared.overrides).toEqual({ maxTokens: 48, temperature: 0.35 });
            const active = createGeneration({ handle: 'contract-user', clientRequestId: 'sampling-active', characterId: 'sampling-shared', chatId: 'contract-created-chat', type: 'normal', targetKind: 'group', directories }).record;
            try {
                const blocked = await fetch(samplingUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: shared.revision, overrides: {} }) });
                expect(blocked.status).toBe(409);
            } finally { cancel(active); }
        } finally { fs.unlinkSync(sharedGroupFile); }
        const currentSampling = await (await fetch(samplingUrl)).json();
        const concurrent = await Promise.all([0.4, 0.5].map(temperature => fetch(samplingUrl, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expectedRevision: currentSampling.revision, overrides: { temperature, maxTokens: 48 } }),
        })));
        expect(concurrent.map(response => response.status).sort()).toEqual([200, 409]);
        const updatedSampling = await (await fetch(samplingUrl)).json();
        const restoredSampling = await fetch(samplingUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expectedRevision: updatedSampling.revision, overrides: samplingBody.overrides }) });
        expect(restoredSampling.status).toBe(200);
        const beforePreview = fs.readFileSync(previewFile);
        const providerCount = providerRequests.length;
        const preview = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats/contract-created-chat/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterId: 'Aria', input: 'Hello group' }),
        });
        expect(preview.status).toBe(200);
        const previewBody = await preview.json();
        expect(previewBody.messages.some(message => message.content.includes('Hello group'))).toBe(true);
        expect(previewBody.providerRequest).toMatchObject({ temperature: 0.35, max_tokens: 48 });
        expect(providerRequests).toHaveLength(providerCount);
        expect(fs.readFileSync(previewFile)).toEqual(beforePreview);
        const originalSettings = readSettings(directories);
        try {
            const settings = structuredClone(originalSettings);
            settings.oai_settings.prompts.find(prompt => prompt.identifier === 'main').content = '{{input}}/{{lastGenerationType}}/{{isMobile}}/{{incvar::previewOnly}}';
            writeSettings(directories, settings);
            const contextPreview = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats/contract-created-chat/preview`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ characterId: 'Aria', nativeContext: { input: 'Group draft', lastGenerationType: 'continue', isMobile: true, locale: 'en-US', timeZone: 'UTC' } }),
            });
            expect(contextPreview.status).toBe(200);
            const contextResult = await contextPreview.json();
            expect(contextResult.messages.some(message => message.content === 'Group draft/continue/true/1')).toBe(true);
            expect(contextResult.warnings.macroStateChanges).toEqual({ local: true, global: false });
            expect(fs.readFileSync(previewFile)).toEqual(beforePreview);
            expect(providerRequests).toHaveLength(providerCount);
        } finally { writeSettings(directories, originalSettings); }
        const unknownMember = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats/contract-created-chat/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'Unknown' }),
        });
        expect(unknownMember.status).toBe(404);
        const validPreviewChat = fs.readFileSync(previewFile);
        fs.appendFileSync(previewFile, '{invalid json}\n');
        const invalidPreview = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats/contract-created-chat/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'Aria' }),
        });
        expect(invalidPreview.status).toBe(422);
        fs.writeFileSync(previewFile, JSON.stringify({ name: 'Aria', is_user: false, mes: 'Legacy greeting' }) + '\n');
        const legacyBytes = fs.readFileSync(previewFile);
        const legacyPreview = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats/contract-created-chat/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'Aria' }),
        });
        expect(legacyPreview.status).toBe(200);
        expect((await legacyPreview.json()).messages.some(message => message.content.includes('Legacy greeting'))).toBe(true);
        expect(fs.readFileSync(previewFile)).toEqual(legacyBytes);
        const legacySampling = await (await fetch(samplingUrl)).json();
        expect(legacySampling.overrides).toEqual({});
        const legacySave = await fetch(samplingUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: legacySampling.revision, overrides: { temperature: 0.45 } }) });
        expect(legacySave.status).toBe(200);
        const legacyRows = fs.readFileSync(previewFile, 'utf8').split('\n').map(JSON.parse);
        expect(legacyRows[0].chat_metadata.messenger_sampling).toEqual({ temperature: 0.45 });
        expect(legacyRows[1]).toEqual({ name: 'Aria', is_user: false, mes: 'Legacy greeting' });
        const legacyConfiguredPreview = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats/contract-created-chat/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'Aria' }),
        });
        const legacyConfigured = await legacyConfiguredPreview.json();
        expect(legacyConfigured.providerRequest.temperature).toBe(0.45);
        expect(legacyConfigured.messages.some(message => message.content.includes('Legacy greeting'))).toBe(true);
        const continuePreview = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats/contract-created-chat/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'Aria', type: 'continue' }),
        });
        expect(continuePreview.status).toBe(200);
        fs.writeFileSync(previewFile, JSON.stringify({ name: 'Other', original_avatar: 'other.png', is_user: false, mes: 'Other reply' }) + '\n');
        const wrongSpeaker = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats/contract-created-chat/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'Aria', type: 'continue' }),
        });
        expect(wrongSpeaker.status).toBe(409);
        const wrongRegeneration = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats/contract-created-chat/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'Aria', type: 'regenerate' }),
        });
        expect(wrongRegeneration.status).toBe(200);
        expect((await wrongRegeneration.json()).messages.some(message => message.content.includes('Other reply'))).toBe(false);
        fs.writeFileSync(previewFile, Buffer.from([0xff]));
        const invalidPage = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats/contract-created-chat`);
        expect(invalidPage.status).toBe(422);
        const invalidUtf8 = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats/contract-created-chat/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'Aria' }),
        });
        expect(invalidUtf8.status).toBe(422);
        fs.writeFileSync(previewFile, JSON.stringify({ chat_metadata: [] }) + '\n');
        expect((await fetch(`${baseUrl}/api/v1/groups/contract-group/chats/contract-created-chat`)).status).toBe(422);
        expect((await fetch(`${baseUrl}/api/v1/groups/contract-group/chats/contract-created-chat/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'Aria' }),
        })).status).toBe(422);
        fs.writeFileSync(previewFile, '');
        const emptyPreview = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats/contract-created-chat/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'Aria' }),
        });
        expect(emptyPreview.status).toBe(200);
        expect(fs.statSync(previewFile).size).toBe(0);
        fs.writeFileSync(previewFile, validPreviewChat);
        const existingFile = path.join(directories.groupChats, 'contract-created-chat.jsonl');
        const originalChat = fs.readFileSync(existingFile, 'utf8');
        const duplicate = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: 'contract-created-chat', expectedRevision: updated.revision }),
        });
        expect(duplicate.status).toBe(409);
        expect(fs.readFileSync(existingFile, 'utf8')).toBe(originalChat);
        const staleCreate = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: 'contract-stale-chat', expectedRevision: document.revision }),
        });
        expect(staleCreate.status).toBe(409);
        expect(fs.existsSync(path.join(directories.groupChats, 'contract-stale-chat.jsonl'))).toBe(false);

        fs.mkdirSync(directories.groupChats, { recursive: true });
        fs.writeFileSync(path.join(directories.groupChats, 'contract-group-chat.jsonl'), [
            JSON.stringify({ chat_metadata: { contract: true } }),
            JSON.stringify({ name: 'Aria', is_user: false, mes: 'Group greeting' }),
        ].join('\n'));
        const chats = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats`);
        expect(chats.status).toBe(200);
        expect((await chats.json())[0].id).toBe('contract-group-chat');

        const page = await fetch(`${baseUrl}/api/v1/groups/contract-group/chats/contract-group-chat?limit=1`);
        expect(page.status).toBe(200);
        expect((await page.json()).messages).toHaveLength(1);

        const stale = await fetch(`${baseUrl}/api/v1/groups/contract-group`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expectedRevision: '0'.repeat(64), group: document.group }),
        });
        expect(stale.status).toBe(409);
        const refused = await fetch(`${baseUrl}/api/v1/groups/contract-group?expectedRevision=${updated.revision}`, { method: 'DELETE' });
        expect(refused.status).toBe(409);
        const removed = await fetch(`${baseUrl}/api/v1/groups/contract-group?expectedRevision=${updated.revision}&deleteChats=true`, { method: 'DELETE' });
        expect(removed.status).toBe(200);
        expect(fs.existsSync(path.join(directories.groupChats, 'contract-group-chat.jsonl'))).toBe(false);
    });

    test('reads legacy group chat identifiers and empty active chat selection', async () => {
        const groupId = 'legacy-group-contract';
        const file = path.join(directories.groups, `${groupId}.json`);
        try {
            fs.writeFileSync(file, JSON.stringify({ id: groupId, name: 'Legacy', members: ['Aria'] }));
            let response = await fetch(`${baseUrl}/api/v1/groups/${groupId}`);
            expect(response.status).toBe(200);
            let document = await response.json();
            expect(document.group.chat_id).toBe(groupId);
            expect(document.group.chats).toEqual([groupId]);
            expect(document.group.members).toEqual(['Aria.png']);

            const saved = await fetch(`${baseUrl}/api/v1/groups/${groupId}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expectedRevision: document.revision, group: { ...document.group, name: 'Migrated' } }),
            });
            expect(saved.status).toBe(200);
            const migrated = JSON.parse(fs.readFileSync(file, 'utf8'));
            expect(migrated.name).toBe('Migrated');
            expect(migrated.members).toEqual(['Aria.png']);
            expect(migrated.chats).toEqual([groupId]);

            const unmatched = JSON.stringify({ id: groupId, name: 'Legacy', members: ['Missing character'] });
            fs.writeFileSync(file, unmatched);
            response = await fetch(`${baseUrl}/api/v1/groups/${groupId}`);
            expect(response.status).toBe(422);
            expect(fs.readFileSync(file, 'utf8')).toBe(unmatched);

            fs.writeFileSync(file, JSON.stringify({ id: groupId, name: 'Legacy', members: ['Aria.png'], chat_id: '', chats: [] }));
            response = await fetch(`${baseUrl}/api/v1/groups/${groupId}`);
            expect(response.status).toBe(200);
            document = await response.json();
            expect(document.group.chat_id).toBe('');
            expect(document.group.chats).toEqual([]);
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    test('checks every group chat before deleting any when a generation is active', async () => {
        const groupId = 'fenced-group';
        const chatIds = ['fenced-first', 'fenced-second'];
        const created = await fetch(`${baseUrl}/api/v1/groups`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId, group: { name: 'Fenced', members: ['Aria.png'], chats: chatIds } }),
        });
        const document = await created.json();
        for (const chatId of chatIds) fs.writeFileSync(path.join(directories.groupChats, `${chatId}.jsonl`), '{}\n');
        const { record } = createGeneration({ handle: 'contract-user', clientRequestId: 'fenced-group-test', characterId: groupId, chatId: chatIds[1], type: 'normal', targetKind: 'group' });
        try {
            const update = await fetch(`${baseUrl}/api/v1/groups/${groupId}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expectedRevision: document.revision, group: { ...document.group, name: 'Changed' } }),
            });
            expect(update.status).toBe(409);
            expect(JSON.parse(fs.readFileSync(path.join(directories.groups, `${groupId}.json`))).name).toBe('Fenced');
            const missingChat = path.join(directories.groupChats, `${chatIds[1]}.jsonl`);
            fs.unlinkSync(missingChat);
            const initialize = await fetch(`${baseUrl}/api/v1/groups/${groupId}/chats`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chatId: chatIds[1], expectedRevision: document.revision }),
            });
            expect(initialize.status).toBe(409);
            expect(fs.existsSync(missingChat)).toBe(false);
            fs.writeFileSync(missingChat, '{}\n');
            const response = await fetch(`${baseUrl}/api/v1/groups/${groupId}?expectedRevision=${document.revision}&deleteChats=true`, { method: 'DELETE' });
            expect(response.status).toBe(409);
            for (const chatId of chatIds) expect(fs.existsSync(path.join(directories.groupChats, `${chatId}.jsonl`))).toBe(true);
            expect(fs.existsSync(path.join(directories.groups, `${groupId}.json`))).toBe(true);
        } finally {
            cancel(record);
            for (const chatId of chatIds) fs.rmSync(path.join(directories.groupChats, `${chatId}.jsonl`), { force: true });
            fs.rmSync(path.join(directories.groups, `${groupId}.json`), { force: true });
        }
    });

    test('discovers and abandons group request identities without affecting character discovery', async () => {
        const base = `${baseUrl}/api/v1/generations`;
        const response = await fetch(`${base}/by-client/group-abandon-contract/abandon`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterId: 'same-id', chatId: 'same-chat', targetKind: 'group' }),
        });
        expect(response.status).toBe(200);
        expect((await response.json()).targetKind).toBe('group');
        const characters = await fetch(`${base}?characterId=same-id&chatId=same-chat`);
        expect((await characters.json()).generations).toHaveLength(0);
        const groups = await fetch(`${base}?characterId=same-id&chatId=same-chat&targetKind=group`);
        expect((await groups.json()).generations[0].targetKind).toBe('group');
        const invalid = await fetch(`${base}?characterId=same-id&chatId=same-chat&targetKind=invalid`);
        expect(invalid.status).toBe(400);
    });

    test('a group cannot delete a shared chat while another group is generating', async () => {
        const groupId = 'shared-chat-other-group';
        const chatId = 'shared-chat-fence';
        const chatFile = path.join(directories.groupChats, `${chatId}.jsonl`);
        const created = await fetch(`${baseUrl}/api/v1/groups`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId, group: { name: 'Other', members: ['Aria.png'], chats: [chatId] } }),
        });
        const document = await created.json();
        fs.writeFileSync(chatFile, '{}\n');
        const { record } = createGeneration({ handle: 'contract-user', clientRequestId: 'shared-chat-fence-test', characterId: 'original-group', chatId, type: 'normal', targetKind: 'group', directories });
        try {
            const discovery = await fetch(`${baseUrl}/api/v1/generations?characterId=${groupId}&chatId=${chatId}&targetKind=group`);
            const page = await discovery.json();
            expect(page.generations[0].requestId).toBe(record.requestId);
            expect(page.generations[0].characterId).toBe('original-group');
            const deletion = await fetch(`${baseUrl}/api/v1/groups/${groupId}?expectedRevision=${document.revision}&deleteChats=true`, { method: 'DELETE' });
            expect(deletion.status).toBe(409);
            expect(fs.existsSync(chatFile)).toBe(true);
        } finally {
            cancel(record);
            fs.rmSync(chatFile, { force: true });
            fs.rmSync(path.join(directories.groups, `${groupId}.json`), { force: true });
        }
    });

    test('group swipe preserves legacy indices and fences shared active chats', async () => {
        const groupId = 'legacy-swipe-group';
        const chatId = 'legacy-swipe-chat';
        const groupFile = path.join(directories.groups, `${groupId}.json`);
        const chatFile = path.join(directories.groupChats, `${chatId}.jsonl`);
        fs.writeFileSync(groupFile, JSON.stringify({ name: 'Legacy', members: ['Aria.png'], chats: [chatId], chat_id: chatId }));
        const original = { name: 'Aria', is_user: false, mes: 'First', swipes: ['First', 'Second'], swipe_id: 0 };
        fs.writeFileSync(chatFile, JSON.stringify(original));
        const url = `${baseUrl}/api/v1/groups/${groupId}/chats/${chatId}/swipe`;
        const select = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 0, swipeId: 1 }) });
        let record;
        try {
            expect((await select()).status).toBe(200);
            const rows = fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ mes: 'Second', swipe_id: 1 });
            record = createGeneration({ handle: 'contract-user', clientRequestId: 'legacy-swipe-fence', characterId: 'another-group', chatId, type: 'normal', targetKind: 'group', directories }).record;
            expect((await select()).status).toBe(409);
            const deletion = await fetch(`${baseUrl}/api/v1/groups/${groupId}/chats/${chatId}/messages/delete`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 0, expectedMessage: rows[0] }),
            });
            expect(deletion.status).toBe(409);
            const edit = await fetch(`${baseUrl}/api/v1/groups/${groupId}/chats/${chatId}/messages/edit`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 0, expectedMessage: rows[0], text: 'Blocked' }),
            });
            expect(edit.status).toBe(409);
            expect(JSON.parse(fs.readFileSync(chatFile, 'utf8'))).toEqual(rows[0]);
        } finally {
            if (record) cancel(record);
            fs.rmSync(chatFile, { force: true });
            fs.rmSync(groupFile, { force: true });
        }
    });

    test('group message editing preserves a headerless legacy transcript', async () => {
        const groupId = 'legacy-edit-group';
        const chatId = 'legacy-edit-chat';
        const groupFile = path.join(directories.groups, `${groupId}.json`);
        const chatFile = path.join(directories.groupChats, `${chatId}.jsonl`);
        const message = { name: 'Aria', original_avatar: 'Aria.png', is_user: false, mes: 'First', swipes: ['First', 'Second'], swipe_id: 1 };
        fs.writeFileSync(groupFile, JSON.stringify({ name: 'Legacy', members: ['Aria.png'], chats: [chatId], chat_id: chatId }));
        fs.writeFileSync(chatFile, JSON.stringify(message));
        try {
            const response = await fetch(`${baseUrl}/api/v1/groups/${groupId}/chats/${chatId}/messages/edit`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 0, expectedMessage: { ...message, index: 0 }, text: 'New {{char}}' }),
            });
            expect(response.status).toBe(200);
            const rows = fs.readFileSync(chatFile, 'utf8').split('\n').map(JSON.parse);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ mes: 'New Aria', swipes: ['First', 'New Aria'], swipe_id: 1 });
        } finally {
            fs.rmSync(chatFile, { force: true });
            fs.rmSync(groupFile, { force: true });
        }
    });

    test('deleting a group does not remove a chat referenced by another group', async () => {
        const chatId = 'shared-delete-chat';
        const groupIds = ['shared-delete-one', 'shared-delete-two'];
        const chatFile = path.join(directories.groupChats, `${chatId}.jsonl`);
        const documents = [];
        try {
            for (const groupId of groupIds) {
                const response = await fetch(`${baseUrl}/api/v1/groups`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ groupId, group: { name: groupId, members: ['Aria.png'], chats: [chatId] } }),
                });
                expect(response.status).toBe(201);
                documents.push(await response.json());
            }
            fs.writeFileSync(chatFile, '{}\n');
            const deletion = await fetch(`${baseUrl}/api/v1/groups/${groupIds[0]}?expectedRevision=${documents[0].revision}&deleteChats=true`, { method: 'DELETE' });
            expect(deletion.status).toBe(409);
            expect(fs.existsSync(chatFile)).toBe(true);
            expect(fs.existsSync(path.join(directories.groups, `${groupIds[0]}.json`))).toBe(true);
            fs.writeFileSync(path.join(directories.groups, `${groupIds[1]}.json`), '{invalid');
            const invalid = await fetch(`${baseUrl}/api/v1/groups/${groupIds[0]}?expectedRevision=${documents[0].revision}&deleteChats=true`, { method: 'DELETE' });
            expect(invalid.status).toBe(409);
            expect(fs.existsSync(chatFile)).toBe(true);
        } finally {
            fs.rmSync(chatFile, { force: true });
            for (const groupId of groupIds) fs.rmSync(path.join(directories.groups, `${groupId}.json`), { force: true });
        }
    });

    test('reads and patches settings while preserving unknown fields', async () => {
        await fetch(`${baseUrl}/api/v1/settings`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ futureNativeField: { keep: true }, username: 'Compose User' }),
        });
        const response = await fetch(`${baseUrl}/api/v1/settings`);
        const body = await response.json();
        expect(body.raw.username).toBe('Compose User');
        expect(body.raw.futureNativeField).toEqual({ keep: true });
        expect(body.typed.oai_settings.custom_model).toBe('mock-model');
    });

    test('provider credential routes never return the stored key', async () => {
        const initial = await (await fetch(`${baseUrl}/api/v1/provider-credentials`)).json();
        expect(initial.customConfigured).toBe(false);
        const key = 'contract-secret-value';
        const savedResponse = await fetch(`${baseUrl}/api/v1/provider-credentials`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'custom', apiKey: key }),
        });
        const savedText = await savedResponse.text();
        expect(savedResponse.status).toBe(200);
        expect(savedText).not.toContain(key);
        expect((await (await fetch(`${baseUrl}/api/v1/provider-credentials`)).json()).customConfigured).toBe(true);
        const replacement = await fetch(`${baseUrl}/api/v1/provider-credentials`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'custom', apiKey: 'replacement-secret-value' }),
        });
        expect(replacement.status).toBe(200);
        const deleted = await fetch(`${baseUrl}/api/v1/provider-credentials/custom`, { method: 'DELETE' });
        expect(deleted.status).toBe(200);
        expect((await (await fetch(`${baseUrl}/api/v1/provider-credentials`)).json()).customConfigured).toBe(false);
    });

    test('lists stable character and chat identifiers', async () => {
        const characters = await (await fetch(`${baseUrl}/api/v1/characters`)).json();
        expect(characters).toEqual([expect.objectContaining({ id: 'Aria', avatar: 'Aria.png', name: 'Aria', chatCount: 1 })]);
        const chats = await (await fetch(`${baseUrl}/api/v1/characters/Aria/chats`)).json();
        expect(chats[0].id).toBe('Chat');
        const chat = await (await fetch(`${baseUrl}/api/v1/chats/Chat?characterId=Aria`)).json();
        expect(chat.messages[0].chat_metadata).toEqual({});
    });

    test('chat sampling is revision checked and applies to preview and generation', async () => {
        const file = path.join(directories.chats, 'Aria', 'Sampling.jsonl');
        fs.writeFileSync(file, JSON.stringify({ chat_metadata: { unrelated: 'kept' } }));
        const url = `${baseUrl}/api/v1/chats/Sampling/sampling?characterId=Aria`;
        const headers = { 'Content-Type': 'application/json' };
        try {
            const initial = await (await fetch(url)).json();
            expect(initial.overrides).toEqual({});
            const saved = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: initial.revision, overrides: { temperature: 0.25, maxTokens: 50 } }) });
            expect(saved.status).toBe(200);
            const document = await saved.json();
            expect(document.overrides).toEqual({ maxTokens: 50, temperature: 0.25 });
            const active = createGeneration({ handle: 'contract-user', clientRequestId: 'sampling-fence', characterId: 'Aria', chatId: 'Sampling', type: 'normal', directories }).record;
            try {
                const blocked = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: document.revision, overrides: {} }) });
                expect(blocked.status).toBe(409);
                expect((await (await fetch(url)).json()).overrides).toEqual(document.overrides);
            } finally { cancel(active); }
            const conflict = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: initial.revision, overrides: {} }) });
            expect(conflict.status).toBe(409);
            const invalid = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: document.revision, overrides: { maxTokens: -1 } }) });
            expect(invalid.status).toBe(400);
            const input = { characterId: 'Aria', chatId: 'Sampling', input: 'Sample', type: 'normal' };
            const preview = await fetch(`${baseUrl}/api/v1/generations/preview`, { method: 'POST', headers, body: JSON.stringify(input) });
            expect(preview.status).toBe(200);
            expect((await preview.json()).providerRequest).toMatchObject({ temperature: 0.25, max_tokens: 50 });
            const explicit = await fetch(`${baseUrl}/api/v1/generations/preview`, { method: 'POST', headers, body: JSON.stringify({ ...input, overrides: { temperature: 0.6 } }) });
            expect((await explicit.json()).providerRequest).toMatchObject({ temperature: 0.6, max_tokens: 50 });
            const start = providerRequests.length;
            const generation = await fetch(`${baseUrl}/api/v1/generations`, { method: 'POST', headers, body: JSON.stringify({ ...input, clientRequestId: 'sampling-check' }) });
            expect(generation.status).toBe(202);
            expect((await waitForGeneration((await generation.json()).requestId)).status).toBe('done');
            expect(providerRequests[start]).toMatchObject({ temperature: 0.25, max_tokens: 50 });
            const overridden = await fetch(`${baseUrl}/api/v1/generations`, { method: 'POST', headers, body: JSON.stringify({ ...input, clientRequestId: 'sampling-override-check', overrides: { temperature: 0.6 } }) });
            expect(overridden.status).toBe(202);
            expect((await waitForGeneration((await overridden.json()).requestId)).status).toBe('done');
            expect(providerRequests[start + 1]).toMatchObject({ temperature: 0.6, max_tokens: 50 });
            const header = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
            expect(header.chat_metadata.unrelated).toBe('kept');
        } finally { fs.rmSync(file, { force: true }); }
    });

    test('preview does not call the provider', async () => {
        const before = providerRequests.length;
        const response = await fetch(`${baseUrl}/api/v1/generations/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterId: 'Aria', chatId: 'Chat', clientRequestId: 'preview', input: 'Hello' }),
        });
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body.messages.at(-1).content).toBe('Hello');
        expect(providerRequests.length).toBe(before);
    });

    test('chat creation expands greeting macros once and rejects duplicate IDs before effects', async () => {
        const before = providerRequests.length;
        const userName = readSettings(directories).username;
        const headers = { 'Content-Type': 'application/json' };
        const first = await fetch(`${baseUrl}/api/v1/characters/Aria/chats`, { method: 'POST', headers,
            body: JSON.stringify({ chatId: 'Macro greeting', firstMessage: '{{if true}}Hi {{user}} {{incvar::greeted}}{{/if}}', nativeContext: { locale: 'en-US', timeZone: 'UTC', isMobile: false } }) });
        expect(first.status).toBe(201);
        const chat = await (await fetch(`${baseUrl}/api/v1/chats/Macro%20greeting?characterId=Aria`)).json();
        expect(chat.messages.at(-1).mes).toBe(`Hi ${userName} 1`);
        expect(chat.messages[0].chat_metadata.variables.greeted).toBe(1);
        const duplicate = await fetch(`${baseUrl}/api/v1/characters/Aria/chats`, { method: 'POST', headers,
            body: JSON.stringify({ chatId: 'Macro greeting', firstMessage: '{{setglobalvar::mustNotRun::bad}}' }) });
        expect(duplicate.status).toBe(409);
        expect(readSettings(directories).extension_settings.variables?.global?.mustNotRun).toBeUndefined();
        expect(providerRequests.length).toBe(before);
        expect((await fetch(`${baseUrl}/api/v1/chats/Macro%20greeting?characterId=Aria`, { method: 'DELETE' })).status).toBe(200);
    });

    test.each([
        { now: 0 }, { extensionPrompts: {} }, { locale: 'not_a_locale' }, { timeZone: 'Missing/Zone' },
        { firstDisplayedMessageId: -1 }, { isMobile: 'true' }, { input: 42 }, { lastGenerationType: 'invalid' },
    ])('rejects invalid or privileged native macro context: %j', async nativeContext => {
        const before = providerRequests.length;
        for (const endpoint of ['preview', '']) {
            const response = await fetch(`${baseUrl}/api/v1/generations${endpoint ? '/' + endpoint : ''}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ characterId: 'Aria', chatId: 'Chat', clientRequestId: 'invalid-context', nativeContext }),
            });
            expect(response.status).toBe(400);
        }
        expect(providerRequests.length).toBe(before);
    });

    test('native context reaches the dry-run preview and macro state is never saved by preview', async () => {
        const original = readSettings(directories);
        const chatPath = path.join(directories.chats, 'Aria', 'Chat.jsonl');
        const beforeChat = fs.readFileSync(chatPath, 'utf8');
        const before = providerRequests.length;
        try {
            const settings = structuredClone(original);
            const main = settings.oai_settings.prompts.find(prompt => prompt.identifier === 'main');
            main.content = '{{input}}/{{lastGenerationType}}/{{isMobile}}/{{incvar::previewOnly}}';
            writeSettings(directories, settings);
            const response = await fetch(`${baseUrl}/api/v1/generations/preview`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ characterId: 'Aria', chatId: 'Chat', nativeContext: { input: 'Visible draft', lastGenerationType: 'continue', isMobile: false, locale: 'en-US', timeZone: 'UTC' } }),
            });
            const body = await response.json();
            expect(response.status).toBe(200);
            expect(body.messages.some(message => message.content === 'Visible draft/continue/false/1')).toBe(true);
            expect(body.warnings.macroStateChanges).toEqual({ local: true, global: false });
            expect(fs.readFileSync(chatPath, 'utf8')).toBe(beforeChat);
            expect(providerRequests.length).toBe(before);
        } finally { writeSettings(directories, original); }
    });

    test('streams tokens, commits a message, and supports polling recovery', async () => {
        const response = await fetch(`${baseUrl}/api/v1/generations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterId: 'Aria', chatId: 'Chat', clientRequestId: 'generation-1', type: 'normal', input: 'Hello' }),
        });
        const accepted = await response.json();
        expect(response.status).toBe(202);
        expect(accepted.eventUrl).toContain(accepted.requestId);

        const eventsResponse = await fetch(`${baseUrl}${accepted.eventUrl}?afterSeq=0`);
        const eventsText = await eventsResponse.text();
        expect(eventsText).toContain('event: token');
        expect(eventsText).toContain('event: done');

        const snapshotResponse = await fetch(`${baseUrl}${accepted.snapshotUrl}`);
        const snapshot = await snapshotResponse.json();
        expect(snapshot.status).toBe('done');
        expect(snapshot.text).toBe('Mock reply');
        expect(snapshot.committed).toBe(true);
        expect(snapshot.reasoning).toBe('Think ');

        const chat = await (await fetch(`${baseUrl}/api/v1/chats/Chat?characterId=Aria`)).json();
        expect(chat.messages.at(-2).mes).toBe('Hello');
        expect(chat.messages.at(-1).mes).toBe('Mock reply');
    });

    test('native prompt edits reach preview and actual dispatch in the same order', async () => {
        const original = readSettings(directories);
        try {
            const config = await (await fetch(`${baseUrl}/api/v1/prompt-manager`)).json();
            config.prompts.push({ identifier: 'native-tail', role: 'user', content: 'TAIL {{char}}', system_prompt: false });
            config.order.push({ identifier: 'native-tail', enabled: true });
            const saved = await fetch(`${baseUrl}/api/v1/prompt-manager`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...config, expectedRevision: config.revision }) });
            expect(saved.status).toBe(200);
            const before = providerRequests.length;
            const body = { characterId: 'Aria', chatId: 'Chat', clientRequestId: 'managed-order-generation', input: 'Managed input', type: 'normal' };
            const preview = await (await fetch(`${baseUrl}/api/v1/generations/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
            expect(providerRequests.length).toBe(before);
            expect(preview.messages.at(-1)).toEqual({ role: 'user', content: 'TAIL Aria' });
            const accepted = await (await fetch(`${baseUrl}/api/v1/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
            expect((await waitForGeneration(accepted.requestId)).status).toBe('done');
            expect(providerRequests).toHaveLength(before + 1);
            expect(providerRequests.at(-1).messages).toEqual(preview.messages);
        } finally { writeSettings(directories, original); }
    });

    test('interrupted provider output remains unknown and never becomes an authoritative chat row', async () => {
        const before = await (await fetch(`${baseUrl}/api/v1/chats/Chat?characterId=Aria`)).json();
        const response = await fetch(`${baseUrl}/api/v1/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'Aria', chatId: 'Chat', clientRequestId: 'unknown-stream-generation', type: 'normal', input: 'Truncated outcome' }) });
        expect(response.status).toBe(202);
        const accepted = await response.json();
        const result = await waitForGeneration(accepted.requestId);
        expect(result.status).toBe('unknown');
        expect(result.text).toBe('Incomplete');
        expect(result.committed).toBe(false);
        expect(result.error).toMatchObject({ code: 'unknown', retryable: false });
        const after = await (await fetch(`${baseUrl}/api/v1/chats/Chat?characterId=Aria`)).json();
        expect(after.messages).toEqual(before.messages);
        const acknowledged = await fetch(`${baseUrl}/api/v1/generations/${accepted.requestId}/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedSeq: result.seq }) });
        expect(acknowledged.status).toBe(200);
    });

    test('duplicate clientRequestId is idempotent', async () => {
        const body = { characterId: 'Aria', chatId: 'Chat', clientRequestId: 'duplicate-generation', type: 'normal', input: 'Hi' };
        const first = await (await fetch(`${baseUrl}/api/v1/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
        const second = await (await fetch(`${baseUrl}/api/v1/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
        expect(second.requestId).toBe(first.requestId);
        expect(second.idempotent).toBe(true);
        await waitForGeneration(second.requestId);
    });

    test('rejects unsupported generation types with a stable error body', async () => {
        const response = await fetch(`${baseUrl}/api/v1/generations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterId: 'Aria', chatId: 'Chat', clientRequestId: 'unsupported', type: 'nonsense' }),
        });
        const body = await response.json();
        expect(response.status).toBe(400);
        expect(body.error.code).toBe('validation');
        expect(body.error.requestId).toEqual(expect.any(String));
    });

    test('regenerate re-generates the last reply without leaving a partial user row', async () => {
        const original = await (await fetch(`${baseUrl}/api/v1/chats/Chat?characterId=Aria`)).json();
        const created = await (await fetch(`${baseUrl}/api/v1/generations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterId: 'Aria', chatId: 'Chat', clientRequestId: 'regen-1', type: 'regenerate' }),
        })).json();
        const result = await waitForGeneration(created.requestId);
        expect(result.status).toBe('done');
        expect(result.text).toBe('Mock reply');
        const chat = await (await fetch(`${baseUrl}/api/v1/chats/Chat?characterId=Aria`)).json();
        expect(chat.messages.at(-1).mes).toBe('Mock reply');
        expect(chat.messages.at(-2).is_user).toBe(true);
        expect(chat.messages.length).toBe(original.messages.length);
        expect(chat.messages.at(-1).swipes).toHaveLength(2);
        expect(chat.messages.at(-1).swipe_id).toBe(1);
    });

    test('switching swipes persists the selected alternative and continue updates that alternative only', async () => {
        const operation = async body => fetch(`${baseUrl}/api/v1/chats/Chat/messages`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterId: 'Aria', ...body }),
        });
        const before = await (await fetch(`${baseUrl}/api/v1/chats/Chat?characterId=Aria`)).json();
        const index = before.messages.at(-1).index;
        expect((await operation({ action: 'edit', index, message: { mes: 'New reply' } })).status).toBe(200);
        expect((await operation({ action: 'swipe', index, swipeId: 0 })).status).toBe(200);
        const accepted = await (await fetch(`${baseUrl}/api/v1/generations`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterId: 'Aria', chatId: 'Chat', clientRequestId: 'continue-swipe', type: 'continue', input: 'Finish the sentence.' }),
        })).json();
        expect((await waitForGeneration(accepted.requestId)).status).toBe('done');
        const after = await (await fetch(`${baseUrl}/api/v1/chats/Chat?characterId=Aria`)).json();
        expect(after.messages).toHaveLength(before.messages.length);
        expect(after.messages.at(-1).mes).toBe('Mock replyMock reply');
        expect(after.messages.at(-1).swipes).toEqual(['Mock replyMock reply', 'New reply']);
        expect(after.messages.at(-1).swipe_id).toBe(0);
        expect((await operation({ action: 'swipe', index, swipeId: 100 })).status).toBe(400);
    });

    test('accepted generations fence destructive chat management', async () => {
        const { record } = createGeneration({ handle: 'contract-user', clientRequestId: 'pending-management', characterId: 'Aria', chatId: 'Chat', type: 'normal', directories });
        try {
            const removed = await fetch(`${baseUrl}/api/v1/chats/Chat?characterId=Aria`, { method: 'DELETE' });
            expect(removed.status).toBe(409);
            const renamed = await fetch(`${baseUrl}/api/v1/chats/Chat`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ characterId: 'Aria', newChatId: 'Forbidden' }),
            });
            expect(renamed.status).toBe(409);
            const edit = await fetch(`${baseUrl}/api/v1/chats/Chat/messages`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ characterId: 'Aria', action: 'delete', index: 1 }),
            });
            expect(edit.status).toBe(409);
        } finally {
            cancel(record, 'requested');
        }
    });

    test('creates, pages and deletes chats', async () => {
        const created = await fetch(`${baseUrl}/api/v1/characters/Aria/chats`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: 'Paged Chat' }),
        });
        expect(created.status).toBe(201);
        const page = await (await fetch(`${baseUrl}/api/v1/chats/Paged%20Chat?characterId=Aria&limit=1`)).json();
        expect(page.total).toBe(2);
        expect(page.hasMore).toBe(true);
        expect(page.messages).toHaveLength(1);
        const removed = await fetch(`${baseUrl}/api/v1/chats/Paged%20Chat?characterId=Aria`, { method: 'DELETE' });
        expect(removed.status).toBe(200);
    });

    test('appends, edits, deletes and renames chat content', async () => {
        const created = await fetch(`${baseUrl}/api/v1/characters/Aria/chats`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: 'Managed' }),
        });
        expect(created.status).toBe(201);
        const append = await fetch(`${baseUrl}/api/v1/chats/Managed/messages`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterId: 'Aria', action: 'append', message: { is_user: true, mes: 'before' } }),
        });
        expect((await append.json()).index).toBe(2);
        const edit = await fetch(`${baseUrl}/api/v1/chats/Managed/messages`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterId: 'Aria', action: 'edit', index: 2, message: { mes: 'after' } }),
        });
        expect((await edit.json()).action).toBe('edit');
        const removeMessage = await fetch(`${baseUrl}/api/v1/chats/Managed/messages`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterId: 'Aria', action: 'delete', index: 2 }),
        });
        expect((await removeMessage.json()).index).toBe(-1);
        const rename = await fetch(`${baseUrl}/api/v1/chats/Managed`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterId: 'Aria', newChatId: 'Managed Renamed' }),
        });
        expect(rename.status).toBe(200);
        expect((await rename.json()).id).toBe('Managed Renamed');
        const chat = await fetch(`${baseUrl}/api/v1/chats/Managed%20Renamed?characterId=Aria`);
        expect(chat.status).toBe(200);
        const removedChat = await fetch(`${baseUrl}/api/v1/chats/Managed%20Renamed?characterId=Aria`, { method: 'DELETE' });
        expect(removedChat.status).toBe(200);
    });

    test('reads and patches extension settings when headless plugins are enabled', async () => {
        process.env.SILLYTAVERN_API_V1_HEADLESSPLUGINS = 'true';
        try {
            const patched = await fetch(`${baseUrl}/api/v1/extensions/my-ext/settings`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: true }),
            });
            expect(patched.status).toBe(200);
            const read = await (await fetch(`${baseUrl}/api/v1/extensions/my-ext/settings`)).json();
            expect(read.settings.enabled).toBe(true);
        } finally {
            delete process.env.SILLYTAVERN_API_V1_HEADLESSPLUGINS;
        }
    });

    test('cancellation after completion acknowledges unknown outcome', async () => {
        const created = await (await fetch(`${baseUrl}/api/v1/generations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterId: 'Aria', chatId: 'Chat', clientRequestId: 'cancel-after-done', type: 'quiet', input: 'Reason' }),
        })).json();
        await waitForGeneration(created.requestId);
        const cancelResponse = await fetch(`${baseUrl}${created.cancelUrl}`, { method: 'POST' });
        const body = await cancelResponse.json();
        expect(cancelResponse.status).toBe(202);
        expect(body.outcome).toBe('unknown');
        expect(body.changed).toBe(false);
    });

    test('classifies runtime=webview extensions and serves a restricted same-origin shell', async () => {
        const extensionDirectory = path.join(directories.extensions, 'native-contract');
        fs.mkdirSync(extensionDirectory, { recursive: true });
        fs.writeFileSync(path.join(extensionDirectory, 'manifest.json'), JSON.stringify({
            display_name: 'Native Contract',
            version: '1.0.0',
            runtime: 'webview',
            ui: 'settings.html',
            capabilities: ['extensionSettings'],
        }));
        const extensions = await (await fetch(`${baseUrl}/api/v1/extensions`)).json();
        const extension = extensions.find(item => item.id === 'local/native-contract');
        expect(extension.runtime).toBe('webview');
        expect(extension.runtime).not.toBe('legacy');
        const shell = await fetch(`${baseUrl}${extension.shellUrl}`);
        const html = await shell.text();
        expect(shell.status).toBe(200);
        expect(html).toContain('Content-Security-Policy');
        expect(html).toContain('window.SillyTavern');
    });
});

async function waitForGeneration(requestId) {
    for (let attempt = 0; attempt < 50; attempt++) {
        const snapshot = await (await fetch(`${baseUrl}/api/v1/generations/${requestId}`)).json();
        if (['done', 'error', 'unknown', 'cancelled'].includes(snapshot.status)) return snapshot;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Generation ${requestId} did not finish.`);
}

function listen(app) {
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function startMockProvider() {
    providerRequests = [];
    return new Promise(resolve => {
        const server = express();
        server.use(express.json());
        server.post('/v1/chat/completions', (request, response) => {
            providerRequests.push(request.body);
            if (groupToCancel && request.body.messages.some(message => message.content?.includes('Cancel second group reply')) && request.body.messages.some(message => message.content?.includes('Mock reply'))) {
                cancel(groupToCancel);
                response.type('text/event-stream').end();
                return;
            }
            if (request.body.messages.some(message => message.content?.includes('Interrupt second group reply')) && request.body.messages.some(message => message.content?.includes('Mock reply'))) {
                response.type('text/event-stream').end('data: {"choices":[{"delta":{"content":"Incomplete"}}]}\n\n');
                return;
            }
            if (request.body.messages.some(message => message.content?.includes('Truncated outcome'))) {
                response.type('text/event-stream').end('data: {"choices":[{"delta":{"content":"Incomplete"}}]}\n\n');
                return;
            }
            response.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            response.write('data: {"choices":[{"delta":{"reasoning_content":"Think "},"index":0}]}\n\n');
            response.write('data: {"choices":[{"delta":{"content":"Mock "},"index":0}]}\n\n');
            response.write('data: {"choices":[{"delta":{"content":"reply"},"index":0}]}\n\n');
            response.end('data: [DONE]\n\n');
        });
        const listener = server.listen(0, '127.0.0.1', () => resolve(listener));
    });
}
