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
const key = 'claude-private-key-123';
const capability = 'loopback-private-capability-456';
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const text = value => event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } });

beforeEach(async () => {
    setConfigFilePath(path.join(serverDirectory, 'default/config.yaml'));
    ({ SECRET_KEYS, writeSecret } = await import('../src/endpoints/secrets.js'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-claude-provider-'));
    writeSecret({ root }, SECRET_KEYS.CLAUDE, key);
    observed = null;
    record = createGeneration({ handle: 'claude-test', clientRequestId: 'test', characterId: 'a', chatId: 'c', type: 'normal' }).record;
    const app = express();
    app.use(express.json());
    app.post('/v1/messages', (request, response) => {
        observed = { headers: request.headers, body: request.body };
        handler(request, response);
    });
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    base = `http://127.0.0.1:${server.address().port}/v1`;
});

afterEach(async () => {
    clearGenerations();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
});

const sourceRequest = () => ({ user: { directories: { root }, profile: { handle: 'claude-test' } }, headers: { authorization: capability } });
const providerRequest = () => ({
    chat_completion_source: 'claude', provider_format: 'anthropic-messages', custom_url: base,
    model: 'claude-test-model', max_tokens: 64, temperature: 2, top_p: 0.7, stop: ['END'],
    messages: [
        { role: 'system', content: 'System one' },
        { role: 'system', content: 'System two' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'Again' },
    ],
});

function completeStream(textValue = 'Claude reply') {
    return event('message_start', { type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 1 } } })
        + event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        + text(textValue)
        + event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
        + event('message_stop', { type: 'message_stop' });
}

describe('Claude Messages provider transport', () => {
    test('converts prompts, sends x-api-key and decodes a bounded terminal stream', async () => {
        handler = (_request, response) => response.type('text/event-stream').end(completeStream());
        const result = await runChatCompletion(sourceRequest(), providerRequest(), record);
        expect(observed.headers['x-api-key']).toBe(key);
        expect(observed.headers['anthropic-version']).toBe('2023-06-01');
        expect(observed.headers.authorization).toBeUndefined();
        expect(observed.body.system).toBe('System one\n\nSystem two');
        expect(observed.body.messages).toEqual([
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi' },
            { role: 'user', content: 'Again' },
        ]);
        expect(observed.body.max_tokens).toBe(64);
        expect(observed.body.temperature).toBe(1);
        expect(observed.body.stop_sequences).toEqual(['END']);
        expect(observed.body.stream).toBe(true);
        expect(result.text).toBe('Claude reply');
        expect(result.usage).toEqual({ input_tokens: 7, output_tokens: 5 });
        expect(record.text).toBe('Claude reply');
        expect(JSON.stringify(observed.body)).not.toContain(key);
        expect(JSON.stringify(observed.body)).not.toContain(capability);
    });

    test('keeps the admitted Claude key and endpoint after settings change', async () => {
        writeSettings({ root }, { main_api: 'openai', oai_settings: { chat_completion_source: 'claude', claude_model: 'claude-test-model', reverse_proxy: base } });
        const session = await prepareProviderSession(sourceRequest());
        const newerKey = 'new-claude-key-should-not-be-used';
        writeSecret({ root }, SECRET_KEYS.CLAUDE, newerKey);
        writeSettings({ root }, { main_api: 'openai', oai_settings: { chat_completion_source: 'claude', claude_model: 'different', reverse_proxy: 'https://example.invalid/v1' } });
        handler = (_request, response) => response.type('text/event-stream').end(completeStream('Captured connection'));
        const result = await runSessionChatCompletion(sourceRequest(), providerRequest(), record, session);
        expect(observed.headers['x-api-key']).toBe(key);
        expect(observed.body.model).toBe('claude-test-model');
        expect(result.text).toBe('Captured connection');
        expect(JSON.stringify(session)).not.toContain(key);
        expect(JSON.stringify(session)).not.toContain(newerKey);
    });

    test('rejects EOF, tool use, conflicting stop reasons and malformed events without committing', async () => {
        const cases = [
            text('Partial'),
            event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }),
            event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
                + event('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' } })
                + event('message_stop', { type: 'message_stop' }),
            'event: content_block_delta\ndata: not-json\n\n',
            event('error', { type: 'error', error: { message: `failed ${key}` } }),
        ];
        for (const body of cases) {
            cancel(record);
            clearGenerations();
            record = createGeneration({ handle: 'claude-test', clientRequestId: `case-${body.length}`, characterId: 'a', chatId: 'c', type: 'normal' }).record;
            handler = (_request, response) => response.type('text/event-stream').end(body);
            await expect(runChatCompletion(sourceRequest(), providerRequest(), record)).rejects.toMatchObject({ code: expect.any(String) });
            expect(record.committed).toBe(false);
        }
    });

    test('rejects credential-bearing errors and client-tool catalogs before dispatch', async () => {
        handler = (_request, response) => response.type('text/event-stream').end(completeStream());
        await expect(runChatCompletion(sourceRequest(), providerRequest(), record, null, null, [
            { type: 'function', function: { name: 'lookup', parameters: {} } },
        ])).rejects.toMatchObject({ code: 'unsupported' });
        expect(observed).toBeNull();
        expect(record.providerDispatched).toBe(false);
    });

    test('rejects a supplied tool catalog before admitting a Claude generation', async () => {
        writeSettings({ root }, { main_api: 'openai', oai_settings: {
            chat_completion_source: 'claude', claude_model: 'claude-test-model', reverse_proxy: base,
            openai_max_context: 4096, openai_max_tokens: 64, function_calling: true,
        } });
        handler = (_request, response) => response.type('text/event-stream').end(completeStream());
        const source = sourceRequest();
        const session = await prepareProviderSession(source);
        const catalog = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
        await expect(runSessionChatCompletion(source, providerRequest(), record, session, catalog)).rejects.toMatchObject({ code: 'unsupported' });
        expect(observed).toBeNull();
        expect(record.providerDispatched).toBe(false);
    });
});
