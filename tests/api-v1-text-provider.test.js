import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { write as writePng } from '../src/character-card-parser.js';
import { setConfigFilePath } from '../src/util.js';
import { serverDirectory } from '../src/server-directory.js';
import { writeSettings, readChat, writeChat } from '../src/headless/session.js';
import { buildPrompt, auditPrompt } from '../src/headless/prompt.js';
import { prepareProviderSession, runSessionCompletion } from '../src/headless/provider.js';
import { textProviderBody } from '../src/headless/text-provider.js';
import { createGeneration, clearGenerations, cancel, snapshot } from '../src/headless/generation-store.js';
import { runGeneration } from '../src/headless/runtime.js';

let root, directories, server, base, source, settings, record, work, received, route, SECRET_KEYS, writeSecret;
const secret = 'owned-private-text-provider-key';
const capability = 'owned-loopback-capability';
const chat = [{ chat_metadata: {} }, { name: 'Aria', is_user: false, mes: 'Greeting' }];
const character = { name: 'Aria', description: 'Guide {{incvar::prepared}}' };
const sse = text => 'data: ' + JSON.stringify({ choices: [{ index: 0, text, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\ndata: [DONE]\n\n';
beforeAll(async () => {
    setConfigFilePath(path.join(serverDirectory, 'default/config.yaml'));
    ({ SECRET_KEYS, writeSecret } = await import('../src/endpoints/secrets.js'));
});
beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-text-provider-'));
    directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, value)]));
    for (const dir of Object.values(directories)) fs.mkdirSync(dir, { recursive: true });
    received = [];
    const app = express(); app.use(express.json({ limit: '4mb' }));
    route = (_req, res) => res.type('text/event-stream').end(sse('Text reply'));
    app.post('/v1/completions', (req, res) => { received.push({ body: req.body, authorization: req.headers.authorization }); route(req, res); });
    app.post('/redirect', (_req, res) => { received.push({ replay: true }); res.end(); });
    server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    base = `http://127.0.0.1:${server.address().port}/v1`;
    settings = { username: 'Reader', main_api: 'textgenerationwebui', max_context: 2048, amount_gen: 64,
        textgenerationwebui_settings: { type: 'generic', generic_model: 'OwnedTextModel', server_urls: { generic: base } },
        power_user: { tokenizer: 1, sysprompt: { enabled: false }, context: { story_string: '{{description}}', names_as_stop_strings: false } }, extension_settings: {} };
    writeSettings(directories, settings);
    writeSecret(directories, SECRET_KEYS.GENERIC, secret);
    fs.writeFileSync(path.join(directories.characters, 'Aria.png'), writePng(fs.readFileSync(path.join(serverDirectory, 'default/content/default_Seraphina.png')), JSON.stringify(character)));
    fs.mkdirSync(path.join(directories.chats, 'Aria'), { recursive: true });
    writeChat(path.join(directories.chats, 'Aria', 'Chat.jsonl'), chat);
    source = { user: { directories, profile: { handle: 'text-user' } }, headers: { authorization: capability } };
    record = createGeneration({ handle: 'text-user', clientRequestId: 'owned-text', characterId: 'Aria', chatId: 'Chat', type: 'normal', directories }).record;
});
afterEach(async () => {
    cancel(record); if (work) await work; work = null;
    clearGenerations(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
});
const options = { type: 'normal', input: 'Question', characterId: 'Aria', chatId: 'Chat', preview: true, stageUserInput: true };
async function prepared(overrides = {}) {
    const session = await prepareProviderSession(source);
    const built = await buildPrompt(session, character, [...chat, { name: 'Reader', is_user: true, mes: 'Question' }], { ...options, overrides });
    return { session, built };
}
describe('native source text-completion requests', () => {
    test('generic wire packet uses actual source sampler fields, overrides and explicit stops', async () => {
        const { session, built } = await prepared({ temperature: 0.3, maxTokens: 32, topP: 0.7, stop: ['<END>'] });
        expect(built.prompt).toContain('Guide 1'); expect(built.prompt).toContain('Question');
        expect(built.providerRequest).toMatchObject({ provider_format: 'text-completions', api_type: 'generic', temperature: 0.3, max_tokens: 32, top_p: 0.7, stop: ['\n***', '<END>'] });
        expect(built.providerRequest).not.toHaveProperty('messages');
        const audited = await auditPrompt(session, built.providerRequest);
        expect(audited.usedTokens).toBe(built.warnings.tokenBudget.usedTokens);
        const result = await runSessionCompletion(source, built.providerRequest, record, session);
        expect(result.text).toBe('Text reply'); expect(result.usage.total_tokens).toBe(6);
        expect(received).toHaveLength(1);
        expect(received[0].authorization).toBe(`Bearer ${secret}`);
        expect(received[0].authorization).not.toContain(capability);
        expect(received[0].body).toMatchObject({ prompt: built.prompt, temperature: 0.3, max_tokens: 32, top_p: 0.7, stream: true, stop: ['\n***', '<END>'] });
        for (const key of ['api_server', 'api_type', 'provider_format', 'messages', 'max_new_tokens', 'samplers']) expect(received[0].body).not.toHaveProperty(key);
    });
    test('saved chat sampling reaches the text completion request', async () => {
        const chatFile = path.join(directories.chats, 'Aria', 'Chat.jsonl');
        writeChat(chatFile, [{ chat_metadata: { messenger_sampling: { temperature: 0.3, maxTokens: 32, topP: 0.7, stop: ['<END>'] } } }, chat[1]]);
        const session = await prepareProviderSession(source);
        work = runGeneration(source, session, record, { characterId: 'Aria', chatId: 'Chat', type: 'normal', input: 'Question', overrides: {} });
        await work;
        expect(record.status).toBe('done');
        expect(received).toHaveLength(1);
        expect(received[0].body).toMatchObject({ temperature: 0.3, max_tokens: 32, top_p: 0.7, stop: ['\n***', '<END>'] });
        expect(readChat(chatFile)[0].chat_metadata.messenger_sampling).toMatchObject({ temperature: 0.3, maxTokens: 32, topP: 0.7, stop: ['<END>'] });
    });
    test('accepted text URL/source/key remain bound across later provider/key changes', async () => {
        const { session, built } = await prepared();
        writeSecret(directories, SECRET_KEYS.GENERIC, 'new-key-must-not-go-to-old-server');
        writeSettings(directories, { ...settings, textgenerationwebui_settings: { type: 'vllm', server_urls: { vllm: 'https://new.invalid' } } });
        expect(JSON.stringify(session)).not.toContain(secret);
        await runSessionCompletion(source, built.providerRequest, record, session);
        expect(received[0].authorization).toBe(`Bearer ${secret}`);
        await expect(runSessionCompletion(source, { ...built.providerRequest, api_server: 'https://new.invalid/v1/completions' }, record, session)).rejects.toMatchObject({ code: 'conflict' });
        await expect(runSessionCompletion(source, { ...built.providerRequest, provider_format: 'chat-completions' }, record, session)).rejects.toMatchObject({ code: 'conflict' });
        expect(received).toHaveLength(1);
    });
    test('an interrupted completion keeps text and reported usage with an unknown non-replayable outcome', async () => {
        route = (_req, res) => res.type('text/event-stream').end('data: {"choices":[{"index":0,"text":"Partial"}],"usage":{"completion_tokens":2}}\n\n');
        const { session, built } = await prepared();
        await expect(runSessionCompletion(source, built.providerRequest, record, session)).rejects.toMatchObject({ code: 'unknown', retryable: false });
        expect(record.text).toBe('Partial'); expect(record.usage.completionTokens).toBe(2); expect(received).toHaveLength(1);
    });
    test('HTTP Retry-After errors and redirects are visible and never replayed', async () => {
        route = (_req, res) => res.status(503).set('Retry-After', '0').send(`No quota ${secret} ${capability}`);
        const { session, built } = await prepared();
        await expect(runSessionCompletion(source, built.providerRequest, record, session)).rejects.toMatchObject({ code: 'provider', message: expect.stringContaining('HTTP 503') });
        expect(received).toHaveLength(1);
        route = (_req, res) => res.redirect(307, '/redirect');
        await expect(runSessionCompletion(source, built.providerRequest, record, session)).rejects.toMatchObject({ code: 'provider' });
        expect(received).toHaveLength(2); expect(received.some(entry => entry.replay)).toBe(false);
    });
    test('post-hook prompt overflow is rejected before dispatch without macro replay', async () => {
        const { session, built } = await prepared();
        await expect(runSessionCompletion(source, { ...built.providerRequest, prompt: 'overflow '.repeat(6000) }, record, session)).rejects.toMatchObject({ code: 'validation' });
        expect(received).toHaveLength(0); expect(record.providerDispatched).toBe(false);
        expect(built.macroEffects.metadata.variables.prepared).toBe(1);
    });
    test('real lifecycle commits text, advances metadata once and records usage on success', async () => {
        const session = await prepareProviderSession(source);
        work = runGeneration(source, session, record, { characterId: 'Aria', chatId: 'Chat', type: 'normal', input: 'Question', overrides: {} });
        await work;
        expect(snapshot(record).status).toBe('done'); expect(record.committed).toBe(true);
        const stored = readChat(path.join(directories.chats, 'Aria', 'Chat.jsonl'));
        expect(stored.at(-1).mes).toBe('Text reply'); expect(stored.at(-2).mes).toBe('Question');
        expect(stored[0].chat_metadata.variables.prepared).toBe(1);
        expect(record.usage.totalTokens).toBe(6); expect(received).toHaveLength(1);
    });
    test('source dynamic temperature and raw token bans/bias are preserved for ooba', async () => {
        settings.textgenerationwebui_settings = { type: 'ooba', custom_model: 'llama', server_urls: { ooba: base }, dynatemp: true, min_temp: 0.2, max_temp: 0.8, banned_tokens: '[7,8]\n"literal ban"', logit_bias: [{ text: '[9]', value: -2 }] };
        writeSettings(directories, settings);
        const { built } = await prepared();
        const body = textProviderBody(built.providerRequest);
        expect(body).toMatchObject({ temperature: 0.5, dynamic_temperature: true, dynatemp_low: 0.2, dynatemp_high: 0.8, banned_strings: ['literal ban'], logit_bias: { 9: -2 } });
        expect(body.custom_token_bans).toBe('7,8'); expect(body).not.toHaveProperty('parseSequenceBreakers');
    });
    test('multiple vllm choices and unsupported CFG on a generic endpoint fail visibly', async () => {
        settings.textgenerationwebui_settings = { type: 'vllm', vllm_model: 'Owned', server_urls: { vllm: base }, n: 2 };
        writeSettings(directories, settings);
        await expect(prepared()).rejects.toMatchObject({ code: 'unsupported' });
        settings.textgenerationwebui_settings = { type: 'generic', generic_model: 'Owned', server_urls: { generic: base }, guidance_scale: 2, negative_prompt: 'No darkness' };
        writeSettings(directories, settings);
        await expect(prepared()).rejects.toMatchObject({ code: 'unsupported' });
        expect(received).toHaveLength(0);
    });
});
