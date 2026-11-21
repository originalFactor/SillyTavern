import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { runChatCompletion, ProviderSseDecoder, prepareProviderSession, runSessionChatCompletion } from '../src/headless/provider.js';
import { clearGenerations, createGeneration } from '../src/headless/generation-store.js';
import { writeSettings } from '../src/headless/session.js';
import { publicConfiguration } from '../src/headless/redaction.js';
import { setConfigFilePath } from '../src/util.js';
import { serverDirectory } from '../src/server-directory.js';

let root, server, base, record, calls, forwarded;
const secret = 'private-provider-credential-123';
const capability = 'private-loopback-capability-456';
let route;
let SECRET_KEYS, writeSecret;
beforeEach(async () => {
    setConfigFilePath(path.join(serverDirectory, 'default/config.yaml'));
    ({ SECRET_KEYS, writeSecret } = await import('../src/endpoints/secrets.js'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-provider-contract-'));
    calls = 0;
    forwarded = 0;
    writeSecret({ root }, SECRET_KEYS.CUSTOM, secret);
    record = createGeneration({ handle: 'provider-test', clientRequestId: 'test', characterId: 'a', chatId: 'c', type: 'normal' }).record;
    const app = express();
    app.use(express.json());
    app.post('/v1/chat/completions', (req, res) => { calls++; route(req, res); });
    app.post('/redirect', (_req, res) => { forwarded++; res.send('must not dispatch'); });
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    base = `http://127.0.0.1:${server.address().port}/v1`;
});
afterEach(async () => {
    clearGenerations();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
});
const request = () => runChatCompletion({ user: { directories: { root } }, headers: { authorization: capability } }, { chat_completion_source: 'custom', custom_url: base, model: 'test', messages: [{ role: 'user', content: 'Hello' }] }, record);
const token = content => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;

describe('non-replaying bounded provider dispatch', () => {
    test('accepted workers keep the captured key even if provider settings and credentials later change', async () => {
        writeSettings({ root }, { main_api: 'openai', oai_settings: { chat_completion_source: 'custom', custom_model: 'old-model', custom_url: base } });
        const sourceRequest = { user: { directories: { root }, profile: { handle: 'owner' } }, headers: {} };
        const session = await prepareProviderSession(sourceRequest);
        const newerKey = 'new-provider-credential-never-send-to-old-endpoint';
        writeSecret({ root }, SECRET_KEYS.CUSTOM, newerKey);
        writeSettings({ root }, { main_api: 'openai', oai_settings: { chat_completion_source: 'custom', custom_model: 'new-model', custom_url: 'https://new.invalid/v1' } });
        let authorization;
        route = (req, res) => { authorization = req.headers.authorization; res.type('text/event-stream').end(token('Old connection') + 'data: [DONE]\n\n'); };
        const result = await runSessionChatCompletion(sourceRequest, { chat_completion_source: 'custom', custom_url: session.settings.oai_settings.custom_url, model: session.settings.oai_settings.custom_model, messages: [] }, record, session);
        expect(result.text).toBe('Old connection');
        expect(authorization).toBe(`Bearer ${secret}`);
        expect(authorization).not.toContain(newerKey);
        expect(JSON.stringify(session)).not.toContain(secret);
        expect(JSON.stringify(session)).not.toContain(newerKey);
        expect(calls).toBe(1);
    });
    test('rejects a clean EOF with partial tokens as unknown rather than successful text', async () => {
        route = (_req, res) => { res.type('text/event-stream'); res.end(token('Partial reply')); };
        await expect(request()).rejects.toMatchObject({ code: 'unknown', retryable: false });
        expect(record.text).toBe('Partial reply');
        expect(record.committed).toBe(false);
        expect(calls).toBe(1);
    });
    test('reports HTTP status and safe detail, without reflecting credentials or replaying Retry-After', async () => {
        route = (_req, res) => res.status(503).set('Retry-After', '0').send(`Quota unavailable ${secret} ${capability} Authorization: Bearer another-secret`);
        let failure;
        try { await request(); } catch (error) { failure = error; }
        expect(failure).toMatchObject({ code: 'provider', retryable: false });
        expect(failure.message).toContain('HTTP 503');
        expect(failure.message).toContain('Quota unavailable');
        expect(failure.message).not.toContain(secret);
        expect(failure.message).not.toContain(capability);
        expect(failure.message).not.toContain('another-secret');
        expect(calls).toBe(1);
    });
    test('never follows 307 redirects that could replay a billable POST or leak its key', async () => {
        route = (_req, res) => res.redirect(307, '/redirect');
        await expect(request()).rejects.toMatchObject({ code: 'provider' });
        expect(calls).toBe(1);
        expect(forwarded).toBe(0);
    });
    test('accepts complete streams and retains only numeric usage metadata', async () => {
        route = (_req, res) => { res.type('text/event-stream'); res.end(token('Complete') + 'data: {"choices":[{"index":0,"finish_reason":"stop","delta":{}}],"usage":{"total_tokens":4,"credential":"not public","completion_tokens_details":{"reasoning_tokens":1}}}\n\n'); };
        const result = await request();
        expect(result.text).toBe('Complete');
        expect(result.usage).toEqual({ total_tokens: 4, completion_tokens_details: { reasoning_tokens: 1 } });
        expect(record.usage).toEqual({ totalTokens: 4, reasoningTokens: 1 });
        expect(calls).toBe(1);
    });
    test('reported usage survives an interrupted stream without inventing absent zero counts', async () => {
        route = (_req, res) => { res.type('text/event-stream'); res.end(token('Partial') + 'data: {"choices":[],"usage":{"prompt_tokens":5,"prompt_tokens_details":{"cached_tokens":0}}}\n\ndata: {"choices":[],"usage":{"completion_tokens":2,"completion_tokens_details":{"reasoning_tokens":1}}}\n\n'); };
        await expect(request()).rejects.toMatchObject({ code: 'unknown' });
        expect(record.usage).toEqual({ promptTokens: 5, completionTokens: 2, cachedTokens: 0, reasoningTokens: 1 });
        expect(record.usage.totalTokens).toBeUndefined(); expect(calls).toBe(1);
    });
    test('does not misinterpret an HTTP 200 JSON error as successful SSE', async () => {
        route = (_req, res) => res.json({ error: { message: 'not SSE' } });
        await expect(request()).rejects.toMatchObject({ code: 'unknown' });
    });
    test('rejects malformed SSE and explicit stream errors rather than committing a partial reply', async () => {
        route = (_req, res) => { res.type('text/event-stream'); res.end(token('Partial') + `data: {"error":{"message":"Exhausted ${secret}"}}\n\n`); };
        await expect(request()).rejects.toMatchObject({ code: 'provider', message: 'Provider stream error: Exhausted [redacted]' });
        expect(record.committed).toBe(false);
    });
    test('aborts on oversized events without waiting for a potentially unbounded response', async () => {
        route = (_req, res) => { res.type('text/event-stream'); res.end('data: ' + 'x'.repeat(1_048_577)); };
        await expect(request()).rejects.toMatchObject({ code: 'unknown' });
    });
    test('unsupported tool calls fail visibly without executing anything', async () => {
        route = (_req, res) => { res.type('text/event-stream'); res.end('data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"untrusted"}}]}}]}\n\ndata: [DONE]\n\n'); };
        await expect(request()).rejects.toMatchObject({ code: 'unsupported' });
    });
});

describe('SSE and public settings boundaries', () => {
    test('preserves Unicode split between network chunks and fragmented CRLF frames', () => {
        const decoder = new ProviderSseDecoder(record);
        for (const char of token('文字🙂').replaceAll('\n', '\r\n') + 'data: [DONE]\r\n\r\n') decoder.push(char);
        decoder.push('', true);
        expect(record.text).toBe('文字🙂');
        expect(decoder.completed).toBe(true);
    });
    test('preserves ordinary configuration while hiding custom headers and nested credentials', () => {
        const stored = { oai_settings: { custom_include_headers: 'Authorization: Bearer value', custom_model: 'model', openai_max_tokens: 100 }, extension_settings: { plugin: { apiKey: 'hidden', proxy_password: 'hidden' } } };
        const result = publicConfiguration(stored);
        expect(result.oai_settings.custom_model).toBe('model');
        expect(result.oai_settings.openai_max_tokens).toBe(100);
        expect(JSON.stringify(result)).not.toContain('hidden');
        expect(result.oai_settings.custom_include_headers).toBe('[redacted]');
        expect(stored.extension_settings.plugin.apiKey).toBe('hidden');
    });
});
