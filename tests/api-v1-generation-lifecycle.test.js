import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { cancel, clearGenerations, createGeneration, setFinalText, snapshot, subscribe } from '../src/headless/generation-store.js';
import { runGeneration } from '../src/headless/runtime.js';
import { readChat, readSettings, writeChat, writeSettings } from '../src/headless/session.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { write as writePng } from '../src/character-card-parser.js';
import { setConfigFilePath } from '../src/util.js';
import { serverDirectory } from '../src/server-directory.js';

let root, directories, server, session, record, work, calls, providerText;
const initial = [{ chat_metadata: {} }, { name: 'Aria', is_user: false, mes: 'Greeting' }];
const originalEnv = { ...process.env };
beforeAll(() => setConfigFilePath(path.join(serverDirectory, 'default/config.yaml')));
beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-generation-lifecycle-'));
    directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, value)]));
    for (const dir of Object.values(directories)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(directories.characters, 'Aria.png'), writePng(fs.readFileSync(path.join(serverDirectory, 'default/content/default_Seraphina.png')), JSON.stringify({ name: 'Aria', description: 'Guide' })));
    fs.mkdirSync(path.join(directories.chats, 'Aria'), { recursive: true });
    writeChat(path.join(directories.chats, 'Aria', 'Chat.jsonl'), initial);
    writeSettings(directories, { extension_settings: { untouched: { keep: true } } });
    process.env.SILLYTAVERN_API_V1_HEADLESSPLUGINS = 'true';
    calls = 0;
    providerText = 'Reply';
    const app = express();
    app.post('/v1/chat/completions', (_req, res) => { calls++; res.type('text/event-stream').end('data: ' + JSON.stringify({ choices: [{ delta: { content: providerText } }] }) + '\n\ndata: [DONE]\n\n'); });
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    session = { handle: 'lifecycle-user', directories, userName: 'Reader', extensionSettings: {}, settings: { main_api: 'openai', oai_settings: { chat_completion_source: 'custom', custom_model: 'test', custom_url: `http://127.0.0.1:${server.address().port}/v1`, prompts: [{ identifier: 'main', content: 'Reply' }] }, power_user: { context: { story_string: '{{description}}' } } } };
    record = createGeneration({ handle: session.handle, clientRequestId: 'race', characterId: 'Aria', chatId: 'Chat', type: 'normal', directories }).record;
});
afterEach(async () => {
    if (record) cancel(record);
    if (work) await work;
    clearGenerations();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    process.env = { ...originalEnv };
    work = null;
});

function start() {
    work = runGeneration({ user: { directories }, headers: {} }, session, record, { characterId: 'Aria', chatId: 'Chat', type: record.type, input: 'Question', overrides: {} });
}
function extension(hook, event) {
    const dir = path.join(directories.extensions, 'cancellation-race');
    fs.mkdirSync(dir, { recursive: true });
    const signal = path.join(root, 'hook-entered');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ display_name: 'Cancellation race fixture', runtime: 'headless', entry: 'index.mjs', hooks: { [hook]: hook } }));
    fs.writeFileSync(path.join(dir, 'index.mjs'), `
import fs from 'node:fs';
export async function ${hook}(context) {
    ${event ? `if (context.generation.event !== ${JSON.stringify(event)}) return;` : ''}
    fs.writeFileSync(${JSON.stringify(signal)}, 'entered');
    await new Promise(resolve => setTimeout(resolve, 150));
    context.writeExtensionFieldBulk('cancellation-race', { mustNotPersist: true });
    return 'Late transformed reply';
}
`);
    return signal;
}
async function entered(signal) {
    for (let i = 0; i < 200; i++) {
        if (fs.existsSync(signal)) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Fixture hook was not entered.');
}

describe('cancellation admission through asynchronous hooks', () => {
    test('cancellation during worker preparation cannot publish computed macro metadata or call a provider', async () => {
        session.settings.oai_settings.prompts[0].content = '{{incvar::mustNotPersist}}{{setglobalvar::mustNotPersist::value}}';
        const observer = {
            writableEnded: false, status() {}, set() {},
            write(value) { if (value.includes('"stage":"prompt"')) queueMicrotask(() => cancel(record)); },
            end() { this.writableEnded = true; },
        };
        subscribe(record, observer);
        start(); await work;
        expect(record.status).toBe('cancelled');
        expect(record.drained).toBe(true);
        expect(calls).toBe(0);
        expect(readChat(path.join(directories.chats, 'Aria', 'Chat.jsonl'))).toEqual(initial);
        expect(readSettings(directories).extension_settings.variables?.global?.mustNotPersist).toBeUndefined();
    });
    test('actual prompt macros persist once at preparation and are not reexecuted on repeated observation', async () => {
        session.settings.oai_settings.prompts[0].content = '{{incvar::count}} {{setglobalvar::shared::actual}} {{input}}';
        start(); await work;
        expect(record.status).toBe('done');
        const saved = readChat(path.join(directories.chats, 'Aria', 'Chat.jsonl'));
        expect(saved[0].chat_metadata.variables.count).toBe(1);
        expect(saved.at(-2).mes).toBe('Question');
        expect(readSettings(directories).extension_settings.variables.global.shared).toBe('actual');
        expect(record.snapshot.warnings.macroStateChanges).toEqual({ local: true, global: true });
        expect(snapshot(record).warnings.macroStateChanges).toEqual({ local: true, global: true });
        await runGeneration({ user: { directories }, headers: {} }, session, record, { characterId: 'Aria', chatId: 'Chat', type: 'normal', input: 'Question' });
        expect(calls).toBe(1);
        expect(readChat(path.join(directories.chats, 'Aria', 'Chat.jsonl'))[0].chat_metadata.variables.count).toBe(1);
    });
    test('cancellation at the final token-audit stage cannot dispatch a provider or commit history', async () => {
        const observer = { writableEnded: false, status() {}, set() {}, write(value) { if (value.includes('"stage":"budget"')) queueMicrotask(() => cancel(record)); }, end() { this.writableEnded = true; } };
        subscribe(record, observer); start(); await work;
        expect(record.status).toBe('cancelled'); expect(record.drained).toBe(true); expect(calls).toBe(0);
        expect(readChat(path.join(directories.chats, 'Aria', 'Chat.jsonl'))).toEqual(initial);
    });
    test('post-preparation hook growth is rejected before dispatch and cannot publish queued plugin settings', async () => {
        session.settings.oai_settings.openai_max_context = 512; session.settings.oai_settings.openai_max_tokens = 64;
        const dir = path.join(directories.extensions, 'budget-growth'); fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runtime: 'headless', entry: 'index.mjs', hooks: { beforePrompt: 'beforePrompt' } }));
        fs.writeFileSync(path.join(dir, 'index.mjs'), 'export async function beforePrompt(context) { context.messages.push({role:"system",content:"token ".repeat(2000)}); context.writeExtensionFieldBulk("budget-growth",{mustNotPersist:true}); }');
        start(); await work;
        expect(record.status).toBe('error'); expect(record.error.code).toBe('validation'); expect(record.error.message).toContain('final outgoing prompt exceeds'); expect(calls).toBe(0);
        expect(readChat(path.join(directories.chats, 'Aria', 'Chat.jsonl'))).toEqual(initial);
        expect(readSettings(directories).extension_settings['budget-growth']).toBeUndefined();
    });
    test.each([
        ['afterGeneration', null],
        ['onGenerationEvent', 'generation_completed'],
    ])('cancelling while %s is suspended prevents subsequent transcript and settings commits', async (hook, event) => {
        const signal = extension(hook, event);
        start();
        await entered(signal);
        expect(cancel(record)).toBe(true);
        await work;
        expect(calls).toBe(1);
        expect(record.status).toBe('cancelled');
        expect(record.committed).toBe(false);
        expect(readChat(path.join(directories.chats, 'Aria', 'Chat.jsonl'))).toEqual(initial);
        expect(readSettings(directories).extension_settings['cancellation-race']).toBeUndefined();
        expect(readSettings(directories).extension_settings.untouched.keep).toBe(true);
    });
    test('completed Unicode replies longer than 64 KiB agree between snapshots, durable journal and transcript', async () => {
        providerText = 'Long reply 文字🙂 '.repeat(6000);
        start();
        await work;
        expect(record.status).toBe('done');
        expect(record.text).toBe(providerText);
        expect(readChat(path.join(directories.chats, 'Aria', 'Chat.jsonl')).at(-1).mes).toBe(providerText);
        const journal = JSON.parse(fs.readFileSync(path.join(root, 'api-v1-generations', `${record.requestId}.json`), 'utf8'));
        expect(journal.text).toBe(providerText);
    });
    test('quiet completion reports an observed result without claiming a transcript commit', async () => {
        cancel(record);
        record = createGeneration({ handle: session.handle, clientRequestId: 'quiet', characterId: 'Aria', chatId: 'Chat', type: 'quiet', directories }).record;
        start();
        await work;
        expect(record.status).toBe('done');
        expect(record.text).toBe(providerText);
        expect(record.committed).toBe(false);
        expect(readChat(path.join(directories.chats, 'Aria', 'Chat.jsonl'))).toEqual(initial);
    });
    test('local persistence failure after provider dispatch remains unknown rather than a safely retryable error', async () => {
        const signal = extension('afterGeneration', null);
        start();
        await entered(signal);
        fs.renameSync(path.join(directories.chats, 'Aria'), path.join(directories.chats, 'preserved-Aria'));
        fs.writeFileSync(path.join(directories.chats, 'Aria'), 'blocked parent');
        await work;
        expect(record.status).toBe('unknown');
        expect(record.drained).toBe(true);
        expect(record.committed).toBe(false);
        expect(calls).toBe(1);
    });
    test('oversized transformed output fails explicitly instead of silently slicing the saved observation', () => {
        record.text = 'Original';
        expect(() => setFinalText(record, 'x'.repeat(8_388_609))).toThrow('exceeded its size limit');
        expect(record.text).toBe('Original');
    });
    test('an accepted generation cancelled before execution never reaches the provider or rewrites history', async () => {
        cancel(record);
        start();
        await work;
        expect(calls).toBe(0);
        expect(readChat(path.join(directories.chats, 'Aria', 'Chat.jsonl'))).toEqual(initial);
    });
});
