import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { runChatCompletion, ProviderSseDecoder, prepareProviderSession, runSessionChatCompletion, listCustomModels } from '../dist/src/headless/provider.js';
import { cancel, clearGenerations, createGeneration, getGeneration, persistGeneration, snapshot } from '../dist/src/headless/generation-store.js';
import { writeSettings } from '../dist/src/headless/session.js';
import { publicConfiguration } from '../dist/src/headless/redaction.js';
import { setConfigFilePath } from '../dist/src/util.js';
import { serverDirectory } from '../dist/src/server-directory.js';

let root, server, base, record, calls, forwarded, modelCalls, modelRoute;
const secret = 'private-provider-credential-123';
const capability = 'private-loopback-capability-456';
let route;
let SECRET_KEYS, writeSecret;
beforeEach(async () => {
    setConfigFilePath(path.join(serverDirectory, 'default/config.yaml'));
    ({ SECRET_KEYS, writeSecret } = await import('../dist/src/endpoints/secrets.js'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-provider-contract-'));
    calls = 0;
    forwarded = 0;
    modelCalls = 0;
    writeSecret({ root }, SECRET_KEYS.CUSTOM, secret);
    record = createGeneration({ handle: 'provider-test', clientRequestId: 'test', characterId: 'a', chatId: 'c', type: 'normal' }).record;
    const app = express();
    app.use(express.json());
    app.post('/v1/chat/completions', (req, res) => { calls++; route(req, res); });
    app.get('/v1/models', (req, res) => { modelCalls++; modelRoute(req, res); });
    app.get('/model-redirect', (_req, res) => { forwarded++; res.json({ data: [] }); });
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
    test('loads bounded model IDs through the saved custom credential', async () => {
        let authorization;
        modelRoute = (req, res) => {
            authorization = req.headers.authorization;
            res.json({ data: [{ id: 'model-a', name: 'Model A', owned_by: 'provider' }, { id: 'model-a' }, { id: 'model-b', context_length: 32000, max_output_tokens: 4096 }, { id: secret, name: `Exposed ${secret}` }, { name: 'invalid' }] });
        };
        const result = await listCustomModels({ directories: { root } }, base);
        expect(result).toEqual({ models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'model-b', contextWindow: 32000, maxTokens: 4096 }, { id: '[redacted]', name: 'Exposed [redacted]' }] });
        expect(authorization).toBe(`Bearer ${secret}`);
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(modelCalls).toBe(1);
    });
    test('does not follow redirects while fetching custom models', async () => {
        modelRoute = (_req, res) => res.redirect(307, '/model-redirect');
        await expect(listCustomModels({ directories: { root } }, base)).rejects.toMatchObject({ code: 'provider' });
        expect(modelCalls).toBe(1);
        expect(forwarded).toBe(0);
    });
    test('rejects credential-bearing model list URLs before dispatch', async () => {
        await expect(listCustomModels({ directories: { root } }, 'https://user:pass@example.test/v1')).rejects.toMatchObject({ code: 'validation' });
        expect(modelCalls).toBe(0);
    });
    test('rejects oversized custom tool definitions before provider dispatch', async () => {
        writeSettings({ root }, { main_api: 'openai', oai_settings: { chat_completion_source: 'custom', custom_model: 'gpt-4', custom_url: base, openai_max_context: 256, openai_max_tokens: 32 } });
        const sourceRequest = { user: { directories: { root }, profile: { handle: 'owner' } }, headers: {} };
        const session = await prepareProviderSession(sourceRequest);
        route = (_req, res) => res.type('text/event-stream').end(token('Unexpected') + 'data: [DONE]\n\n');
        const tools = [{ type: 'function', function: { name: 'lookup', description: 'definition '.repeat(500), parameters: { type: 'object' } } }];
        await expect(runSessionChatCompletion(sourceRequest, {
            chat_completion_source: 'custom', custom_url: base, model: 'gpt-4', max_tokens: 32,
            messages: [{ role: 'user', content: 'Hello' }],
            custom_include_body: JSON.stringify({ tools, tool_choice: 'auto' }),
        }, record, session)).rejects.toMatchObject({ code: 'validation' });
        expect(calls).toBe(0);
        expect(record.providerDispatched).toBe(false);
    });
    test('audits only tool fields retained after custom body exclusions', async () => {
        writeSettings({ root }, { main_api: 'openai', oai_settings: { chat_completion_source: 'custom', custom_model: 'gpt-4', custom_url: base, openai_max_context: 256, openai_max_tokens: 32 } });
        const sourceRequest = { user: { directories: { root }, profile: { handle: 'owner' } }, headers: {} };
        const session = await prepareProviderSession(sourceRequest);
        let body;
        route = (req, res) => { body = req.body; res.type('text/event-stream').end(token('Complete') + 'data: [DONE]\n\n'); };
        const tools = [{ type: 'function', function: { name: 'lookup', description: 'definition '.repeat(500), parameters: { type: 'object' } } }];
        const result = await runSessionChatCompletion(sourceRequest, {
            chat_completion_source: 'custom', custom_url: base, model: 'gpt-4', max_tokens: 32,
            messages: [{ role: 'user', content: 'Hello' }], tools,
            custom_include_body: JSON.stringify({ tools, tool_choice: 'auto' }),
            custom_exclude_body: '[tools, tool_choice]',
        }, record, session);
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
        expect(calls).toBe(1);
    });
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
    test('dispatches custom OpenAI-compatible requests to the configured base URL with the custom credential', async () => {
        let url, authorization;
        route = (req, res) => { url = req.url; authorization = req.headers.authorization; res.type('text/event-stream').end(token('Custom endpoint') + 'data: [DONE]\n\n'); };
        const result = await request();
        expect(result.text).toBe('Custom endpoint');
        expect(url).toBe('/v1/chat/completions');
        expect(authorization).toBe(`Bearer ${secret}`);
        expect(calls).toBe(1);
    });
    test('rejects invalid custom URLs before dispatch', async () => {
        await expect(runChatCompletion(
            { user: { directories: { root } }, headers: {} },
            { chat_completion_source: 'custom', custom_url: 'https://user:pass@example.invalid/v1', model: 'test', messages: [] },
            record,
        )).rejects.toMatchObject({ code: 'validation' });
        expect(calls).toBe(0);
        expect(record.providerDispatched).toBe(false);
    });
    test('returns each completion independently while retaining the combined stream', async () => {
        route = (_req, res) => res.type('text/event-stream').end(token(calls === 1 ? 'First' : 'Second') + 'data: [DONE]\n\n');
        expect((await request()).text).toBe('First');
        expect((await request()).text).toBe('Second');
        expect(record.text).toBe('FirstSecond');
        expect(calls).toBe(2);
    });
    test('records group usage per real provider call, including interrupted and unreported usage', async () => {
        record = createGeneration({ handle: 'provider-test', clientRequestId: 'group', characterId: 'g', chatId: 'c', type: 'normal', targetKind: 'group', directories: { root } }).record;
        route = (_req, res) => {
            const usage = calls === 1 ? { prompt_tokens: 4, completion_tokens: 2 } : calls === 3 ? { total_tokens: 9 } : null;
            const usageEvent = usage ? `data: ${JSON.stringify({ choices: [], usage })}\n\n` : '';
            res.type('text/event-stream').end(token(`Reply ${calls}`) + usageEvent + (calls === 3 ? '' : 'data: [DONE]\n\n'));
        };
        expect((await request()).text).toBe('Reply 1');
        expect((await request()).text).toBe('Reply 2');
        await expect(request()).rejects.toMatchObject({ code: 'unknown' });
        persistGeneration({ root }, record);
        const requestId = record.requestId;
        clearGenerations();
        const restored = getGeneration(requestId, 'provider-test', { root });
        expect(snapshot(restored).usageByCall).toEqual([{ promptTokens: 4, completionTokens: 2 }, null, { totalTokens: 9 }]);
        expect(restored.providerCallCount).toBe(3);
        expect(restored.status).toBe('unknown');
        expect(calls).toBe(3);
    });
    test('does not dispatch a group provider request if its journal cannot be synchronized', async () => {
        record = createGeneration({ handle: 'provider-test', clientRequestId: 'group', characterId: 'g', chatId: 'c', type: 'normal', targetKind: 'group', directories: { root } }).record;
        const journal = path.join(root, 'api-v1-generations');
        fs.rmSync(journal, { recursive: true });
        fs.writeFileSync(journal, 'unavailable');
        route = (_req, res) => res.type('text/event-stream').end(token('Unexpected') + 'data: [DONE]\n\n');
        await expect(request()).rejects.toMatchObject({ code: 'storage' });
        expect(calls).toBe(0);
    });
    test('rejects an empty later completion even when earlier text exists', async () => {
        record.text = 'Earlier reply';
        route = (_req, res) => res.type('text/event-stream').end('data: [DONE]\n\n');
        await expect(request()).rejects.toMatchObject({ code: 'provider' });
        expect(record.text).toBe('Earlier reply');
    });
    test('keeps later reasoning separate and retains partial output on interruption', async () => {
        const reasoning = value => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: value } }] })}\n\n`;
        route = (_req, res) => res.type('text/event-stream').end(reasoning('First thought') + token('First') + 'data: [DONE]\n\n');
        const first = await request();
        expect(first.reasoning).toBe('First thought');
        route = (_req, res) => res.type('text/event-stream').end(reasoning('Second thought') + token('Partial'));
        await expect(request()).rejects.toMatchObject({ code: 'unknown' });
        expect(record.text).toBe('FirstPartial');
        expect(record.reasoning).toBe('First thoughtSecond thought');
        expect(calls).toBe(2);
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
    test('retains partial text and usage when a streamed tool call is unsupported', async () => {
        route = (_req, res) => {
            res.type('text/event-stream');
            res.end('data: {"choices":[{"index":0,"delta":{"content":"Before tool"}}],"usage":{"prompt_tokens":4}}\n\ndata: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"untrusted","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n');
        };
        await expect(request()).rejects.toMatchObject({ code: 'unsupported', retryable: false });
        expect(record.text).toBe('Before tool');
        expect(record.usage.promptTokens).toBe(4);
        expect(record.committed).toBe(false);
        expect(calls).toBe(1);
    });
    test('retains text and reasoning that share a streamed tool-call frame', async () => {
        route = (_req, res) => {
            res.type('text/event-stream');
            res.end('data: {"choices":[{"index":0,"delta":{"content":"Same frame","reasoning_content":"Thinking","tool_calls":[{"index":0,"id":"call_1","function":{"name":"untrusted","arguments":"{}"}}]}}],"usage":{"prompt_tokens":4}}\n\ndata: [DONE]\n\n');
        };
        await expect(request()).rejects.toMatchObject({ code: 'unsupported', retryable: false });
        expect(record.text).toBe('Same frame');
        expect(record.reasoning).toBe('Thinking');
        expect(record.usage.promptTokens).toBe(4);
        expect(record.committed).toBe(false);
        expect(calls).toBe(1);
    });
    test('unsupported tool calls fail visibly without executing anything', async () => {
        route = (_req, res) => { res.type('text/event-stream'); res.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"untrusted","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n'); };
        await expect(request()).rejects.toMatchObject({ code: 'unsupported' });
    });
    test('reads interleaved tool-call fragments and final usage before reporting unsupported execution', async () => {
        const frame = delta => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
        route = (_req, res) => res.type('text/event-stream').end(
            frame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'look', arguments: '{"q":' } }, { index: 1, id: 'call_2', type: 'function', function: { name: 'read', arguments: '{}' } }] })
            + frame({ tool_calls: [{ index: 0, function: { name: 'up', arguments: '"x"}' } }] })
            + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n'
            + 'data: {"choices":[],"usage":{"completion_tokens":7}}\n\ndata: [DONE]\n\n',
        );
        await expect(request()).rejects.toMatchObject({ code: 'unsupported', retryable: false });
        expect(record.usage.completionTokens).toBe(7);
        expect(record.committed).toBe(false);
        expect(calls).toBe(1);
    });
    test('retains a redacted tool proposal across journal recovery', async () => {
        record = createGeneration({ handle: 'provider-test', clientRequestId: 'tool-proposal', characterId: 'a', chatId: 'tool-chat', type: 'normal', directories: { root } }).record;
        const argumentsJson = JSON.stringify({ query: 'stars', api_key: secret, nested: { password: 'private-password' }, echoed: capability });
        route = (_req, res) => res.type('text/event-stream').end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: argumentsJson } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
        await expect(request()).rejects.toMatchObject({ code: 'unsupported' });
        const requestId = record.requestId;
        clearGenerations();
        const restored = snapshot(getGeneration(requestId, 'provider-test', { root }));
        expect(restored.toolCalls).toHaveLength(1);
        expect(restored.toolCalls[0]).toMatchObject({ id: 'call_1', name: 'lookup' });
        expect(restored.toolCalls[0].arguments).toContain('stars');
        expect(JSON.stringify(restored)).not.toContain(secret);
        expect(JSON.stringify(restored)).not.toContain(capability);
        expect(JSON.stringify(restored)).not.toContain('private-password');
        expect(calls).toBe(1);
    });
    test('redacts credentials containing JSON escape characters before saving tool proposals', async () => {
        const unusualSecret = 'quoted"key\\private';
        writeSecret({ root }, SECRET_KEYS.CUSTOM, unusualSecret);
        const argumentsJson = JSON.stringify({ nested: [{ value: unusualSecret }], [unusualSecret]: 'value' });
        route = (_req, res) => res.type('text/event-stream').end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: argumentsJson } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
        await expect(request()).rejects.toMatchObject({ code: 'unsupported' });
        const saved = snapshot(record).toolCalls[0].arguments;
        expect(saved).not.toContain('private');
        expect(JSON.parse(saved).nested[0].value).toBe('[redacted]');
        expect(JSON.parse(saved)['[redacted]']).toBe('value');
    });
    test('interrupted and malformed tool calls remain unknown without dispatching again', async () => {
        route = (_req, res) => res.type('text/event-stream').end('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{"}}]}}]}\n\n');
        await expect(request()).rejects.toMatchObject({ code: 'unknown', retryable: false });
        expect(calls).toBe(1);
        route = (_req, res) => res.type('text/event-stream').end('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{"}}]}}]}\n\ndata: [DONE]\n\n');
        await expect(request()).rejects.toMatchObject({ code: 'unknown', retryable: false });
        expect(calls).toBe(2);
    });
    test.each(['length', 'content_filter', 'stop'])('does not accept tool calls with %s finish reason', async finishReason => {
        const event = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: finishReason }] };
        route = (_req, res) => res.type('text/event-stream').end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
        await expect(request()).rejects.toMatchObject({ code: 'unknown', retryable: false });
        expect(snapshot(record).toolCalls).toEqual([]);
        expect(calls).toBe(1);
    });
    test('conflicting finish reasons leave the outcome unknown', async () => {
        route = (_req, res) => res.type('text/event-stream').end(token('Partial') + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n');
        await expect(request()).rejects.toMatchObject({ code: 'unknown', retryable: false });
        expect(record.text).toBe('Partial');
        expect(calls).toBe(1);
    });
    test('rejects tool fragments arriving after a completion reason', async () => {
        route = (_req, res) => res.type('text/event-stream').end(token('Partial') + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n');
        await expect(request()).rejects.toMatchObject({ code: 'unknown', retryable: false });
        expect(record.text).toBe('Partial');
        expect(snapshot(record).toolCalls).toEqual([]);
        expect(calls).toBe(1);
    });
    test('cancellation during a token callback stops subsequent tool frames in the same chunk', () => {
        record.workerActive = true;
        record.subscribers.add({ writableEnded: false, write() { cancel(record); }, end() { this.writableEnded = true; } });
        const decoder = new ProviderSseDecoder(record);
        const event = JSON.stringify({ choices: [{ index: 0, delta: { content: 'Partial', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{}' } }] } }] });
        decoder.push(`data: ${event}\n\ndata: [DONE]\n\n`);
        expect(record.cancelRequested).toBe(true);
        expect(decoder.toolCalls).toEqual([]);
        expect(snapshot(record).toolCalls).toEqual([]);
    });
});

describe('SSE and public settings boundaries', () => {
    test('assembles interleaved tool calls without executing them', () => {
        const decoder = new ProviderSseDecoder(record);
        const event = delta => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
        decoder.push(event({ tool_calls: [{ index: 1, id: 'second', function: { name: 'read', arguments: '{}' } }, { index: 0, id: 'first', function: { name: 'look', arguments: '{"q":' } }] }));
        decoder.push(event({ tool_calls: [{ index: 0, function: { name: 'up', arguments: '"x"}' } }] }));
        decoder.push('data: [DONE]\n\n');
        expect(decoder.validatedToolCalls()).toEqual([
            { id: 'first', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
            { id: 'second', type: 'function', function: { name: 'read', arguments: '{}' } },
        ]);
        expect(record.committed).toBe(false);
    });
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
