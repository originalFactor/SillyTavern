import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { runChatCompletion, prepareProviderSession, runSessionChatCompletion } from '../src/headless/provider.js';
import { cancel, clearGenerations, createGeneration } from '../src/headless/generation-store.js';
import { writeSettings } from '../src/headless/session.js';
import { setConfigFilePath } from '../src/util.js';
import { serverDirectory } from '../src/server-directory.js';

let root, server, base, record, observed, handler, SECRET_KEYS, writeSecret;
const key = 'gemini-private-key-123';
const capability = 'loopback-private-capability-456';
const frame = value => `data: ${JSON.stringify(value)}\n\n`;

beforeEach(async () => {
    setConfigFilePath(path.join(serverDirectory, 'default/config.yaml'));
    ({ SECRET_KEYS, writeSecret } = await import('../src/endpoints/secrets.js'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-gemini-provider-'));
    writeSecret({ root }, SECRET_KEYS.MAKERSUITE, key);
    observed = null;
    record = createGeneration({ handle: 'gemini-test', clientRequestId: 'test', characterId: 'a', chatId: 'c', type: 'normal' }).record;
    const app = express();
    app.use(express.json());
    app.post('/v1beta/models/:model', (request, response) => {
        observed = { url: request.originalUrl, params: request.params, query: request.query, headers: request.headers, body: request.body };
        handler(request, response);
    });
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    base = `http://127.0.0.1:${server.address().port}/v1beta`;
});

afterEach(async () => {
    clearGenerations();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
});

const sourceRequest = () => ({ user: { directories: { root }, profile: { handle: 'gemini-test' } }, headers: { authorization: capability } });
const providerRequest = () => ({
    chat_completion_source: 'makersuite', provider_format: 'gemini-generate-content', custom_url: base,
    model: 'gemini-test-model', max_tokens: 64, temperature: 0.5, top_p: 0.8, stop: ['END'],
    messages: [
        { role: 'system', content: 'System one' },
        { role: 'system', content: 'System two' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'Again' },
    ],
});

function completeStream(textValue = 'Gemini reply') {
    return frame({ candidates: [{ content: { parts: [{ text: textValue }] } }], usageMetadata: { promptTokenCount: 7 } })
        + frame({ candidates: [{ content: { parts: [{ text: ' done' }] }, finishReason: 'STOP' }], usageMetadata: { candidatesTokenCount: 3, totalTokenCount: 10 } });
}

describe('Google AI Studio generateContent provider transport', () => {
    test('converts prompts, sends x-goog-api-key and decodes a bounded terminal stream', async () => {
        handler = (_request, response) => response.type('text/event-stream').end(completeStream());
        const result = await runChatCompletion(sourceRequest(), providerRequest(), record);
        expect(observed.headers['x-goog-api-key']).toBe(key);
        expect(observed.query.key).toBe(key);
        expect(observed.query.alt).toBe('sse');
        expect(observed.params.model).toBe('gemini-test-model:streamGenerateContent');
        expect(observed.url).toContain('streamGenerateContent');
        expect(observed.body.systemInstruction.parts).toEqual([{ text: 'System one' }, { text: 'System two' }]);
        expect(observed.body.contents).toEqual([
            { role: 'user', parts: [{ text: 'Hello' }] },
            { role: 'model', parts: [{ text: 'Hi' }] },
            { role: 'user', parts: [{ text: 'Again' }] },
        ]);
        expect(observed.body.generationConfig).toMatchObject({ candidateCount: 1, maxOutputTokens: 64, temperature: 0.5, topP: 0.8, stopSequences: ['END'] });
        expect(result.text).toBe('Gemini reply done');
        expect(result.usage).toEqual({ promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 });
        expect(record.text).toBe('Gemini reply done');
        expect(JSON.stringify(observed.body)).not.toContain(key);
        expect(JSON.stringify(observed.body)).not.toContain(capability);
    });

    test('keeps the admitted Gemini key and endpoint after settings change', async () => {
        writeSettings({ root }, { main_api: 'openai', oai_settings: { chat_completion_source: 'makersuite', google_model: 'gemini-test-model', reverse_proxy: base } });
        const session = await prepareProviderSession(sourceRequest());
        const newerKey = 'new-gemini-key-should-not-be-used';
        writeSecret({ root }, SECRET_KEYS.MAKERSUITE, newerKey);
        writeSettings({ root }, { main_api: 'openai', oai_settings: { chat_completion_source: 'makersuite', google_model: 'different', reverse_proxy: 'https://example.invalid/v1beta' } });
        handler = (_request, response) => response.type('text/event-stream').end(completeStream('Captured connection'));
        const result = await runSessionChatCompletion(sourceRequest(), providerRequest(), record, session);
        expect(observed.headers['x-goog-api-key']).toBe(key);
        expect(observed.query.key).toBe(key);
        expect(result.text).toBe('Captured connection done');
        expect(JSON.stringify(session)).not.toContain(key);
        expect(JSON.stringify(session)).not.toContain(newerKey);
    });

    test('rejects EOF, malformed chunks, media, prompt blocks and late output without committing', async () => {
        const cases = [
            frame({ candidates: [{ content: { parts: [{ text: 'Partial' }] } }] }),
            'data: not-json\n\n',
            frame({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] } }] }),
            frame({ promptFeedback: { blockReason: 'SAFETY' } }),
            frame({ candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] })
                + frame({ candidates: [{ content: { parts: [{ text: 'late' }] } }] }),
        ];
        for (const [index, body] of cases.entries()) {
            cancel(record);
            clearGenerations();
            record = createGeneration({ handle: 'gemini-test', clientRequestId: `case-${index}`, characterId: 'a', chatId: 'c', type: 'normal' }).record;
            handler = (_request, response) => response.type('text/event-stream').end(body);
            await expect(runChatCompletion(sourceRequest(), providerRequest(), record)).rejects.toMatchObject({ code: expect.any(String) });
            expect(record.committed).toBe(false);
        }
    });

    test('rejects client tools and explicit function calls before dispatch', async () => {
        handler = (_request, response) => response.type('text/event-stream').end(completeStream());
        const catalog = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
        await expect(runChatCompletion(sourceRequest(), providerRequest(), record, null, null, catalog)).rejects.toMatchObject({ code: 'unsupported' });
        expect(observed).toBeNull();
        expect(record.providerDispatched).toBe(false);
    });
});
