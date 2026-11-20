import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { router as apiV1Router } from '../src/endpoints/api-v1.js';
import { cancel, clearGenerations, createGeneration } from '../src/headless/generation-store.js';
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
        expect(body.providers.otherChatCompletionSources).toBe(false);
        expect(body.features.serverPlugins).toBe(false);
        expect(body.features.swipes).toBe(true);
        expect(body.features.upstreamMacroEngine).toBe(true);
        expect(body.features.advancedMacros).toBe(false);
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
            if (request.body.messages.some(message => message.content === 'Truncated outcome')) {
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
