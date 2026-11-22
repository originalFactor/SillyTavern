import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { afterEach, beforeAll, beforeEach, expect, test } from '@jest/globals';
import { router } from '../src/endpoints/api-v1.js';
import { DEFAULT_USER, USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { write as writeCard } from '../src/character-card-parser.js';
import { claimClientToolBatch, clientToolCatalogDigest, declineClientToolBatch, submitClientToolResults, validateClientTools, runCompletionWithClientTools } from '../src/headless/client-tools.js';
import { beginGeneration, cancel, clearGenerations, createGeneration, endGeneration, getGeneration, snapshot } from '../src/headless/generation-store.js';
import { prepareProviderSession } from '../src/headless/provider.js';
import { writeSettings } from '../src/headless/session.js';
import { setConfigFilePath } from '../src/util.js';
import { serverDirectory } from '../src/server-directory.js';

let root, server, session, request, record, packet, running;
let packets;
let directories;
let repeatTools;
const tools = [{ type: 'function', function: { name: 'lookup', description: 'Look up a record', parameters: { type: 'object' } } }];
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
beforeAll(() => setConfigFilePath(path.join(serverDirectory, 'default/config.yaml')));
beforeEach(async () => {
    process.env.SILLYTAVERN_API_V1_ENABLED = 'true';
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-client-tools-'));
    directories = { ...Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, value)])), root };
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    const png = fs.readFileSync(path.join(serverDirectory, 'default/content/default_Seraphina.png'));
    fs.writeFileSync(path.join(directories.characters, 'role.png'), writeCard(png, JSON.stringify({ name: 'Role', description: 'A guide', first_mes: 'Hello' }), { preserveSpec: true }));
    fs.mkdirSync(path.join(directories.chats, 'role'));
    fs.writeFileSync(path.join(directories.chats, 'role/chat.jsonl'), JSON.stringify({ chat_metadata: {} }) + '\n');
    packets = [];
    repeatTools = false;
    const app = express();
    app.use(express.json());
    app.post('/v1/chat/completions', (req, res) => {
        packets.push(req.body);
        const toolReply = packets.length === 1 || repeatTools;
        const delta = toolReply ? { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"hello"}' } }] } : { content: 'Found the answer.' };
        res.type('text/event-stream').end(frame({ choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + frame({ choices: [{ delta: {}, finish_reason: toolReply ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n');
    });
    app.use((req, _res, next) => { req.user = { profile: { ...DEFAULT_USER, handle: 'owner' }, directories }; next(); });
    app.use('/api/v1', router);
    server = await new Promise(done => { const value = app.listen(0, '127.0.0.1', () => done(value)); });
    const url = `http://127.0.0.1:${server.address().port}/v1`;
    writeSettings(directories, { main_api: 'openai', oai_settings: { chat_completion_source: 'custom', custom_url: url,
        custom_model: 'gpt-4', openai_max_context: 4096, openai_max_tokens: 100, function_calling: true } });
    request = { user: { directories, profile: { ...DEFAULT_USER, handle: 'owner' } }, headers: {} };
    session = await prepareProviderSession(request);
    packet = { chat_completion_source: 'custom', custom_url: url, model: 'gpt-4', max_tokens: 100, messages: [{ role: 'user', content: 'Question' }] };
    record = createGeneration({ handle: 'owner', clientRequestId: 'caller', characterId: 'role', chatId: 'chat', type: 'normal', directories: { root } }).record;
    beginGeneration(record);
    running = null;
});
afterEach(async () => {
    if (running) { cancel(record); await running.catch(() => {}); }
    endGeneration(record);
    clearGenerations();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.SILLYTAVERN_API_V1_ENABLED;
});
async function startBatch() {
    running = runCompletionWithClientTools(request, packet, record, session, tools);
    running.catch(() => {});
    for (let i = 0; i < 200 && !record.toolBatches?.length; i++) await new Promise(done => setTimeout(done, 10));
    expect(record.toolBatches).toHaveLength(1);
    return record.toolBatches[0];
}
test('waits for an exact claim and ordered results before a single follow-up, with duplicate receipts idempotent', async () => {
    packet.custom_include_body = JSON.stringify({ messages: [{ role: 'user', content: 'Wrong context' }], tools: [{ type: 'function', function: { name: 'wrong' } }], functions: [{ name: 'legacy' }] });
    const batch = await startBatch();
    expect(batch.status).toBe('awaiting_approval');
    expect(batch.catalogRevision).toBe(clientToolCatalogDigest(tools));
    expect(packets).toHaveLength(1);
    expect(packets[0].tools).toEqual(tools);
    expect(packets[0].messages).toEqual(packet.messages);
    expect(packets[0].functions).toBeUndefined();
    expect(() => claimClientToolBatch(record, batch.id, { expectedRevision: 'stale', executionId: 'exec' })).toThrow('proposal changed');
    const input = { expectedRevision: batch.revision, executionId: 'exec' };
    expect(() => submitClientToolResults(record, batch.id, { ...input, results: [] })).toThrow();
    expect(claimClientToolBatch(record, batch.id, input)).toMatchObject({ idempotent: false, dispatchAuthorized: true });
    expect(claimClientToolBatch(record, batch.id, input)).toMatchObject({ idempotent: true, dispatchAuthorized: false });
    expect(() => claimClientToolBatch(record, batch.id, { ...input, executionId: 'another' })).toThrow('already claimed');
    expect(() => submitClientToolResults(record, batch.id, { ...input, results: [{ id: 'other', result: 'Found', isError: false }] })).toThrow('ordered result');
    const result = { ...input, results: [{ id: 'call-1', result: 'Found', isError: false }] };
    expect(submitClientToolResults(record, batch.id, result).idempotent).toBe(false);
    expect(submitClientToolResults(record, batch.id, result).idempotent).toBe(true);
    const completed = await running;
    expect(completed.text).toBe('Found the answer.');
    expect(completed.toolRows[0].extra.tool_invocations[0]).toMatchObject({ id: 'call-1', name: 'lookup', result: 'Found', error: false });
    expect(packets).toHaveLength(2);
    expect(record.usage).toEqual({ promptTokens: 20, completionTokens: 4, totalTokens: 24 });
    expect(record.usageByCall).toHaveLength(2);
    expect(packets[1].messages.slice(-2)).toEqual([
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"hello"}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'Found' },
    ]);
    expect(() => submitClientToolResults(record, batch.id, { ...result, results: [{ id: 'call-1', result: 'Changed', isError: false }] })).toThrow();
});
test('declining an unclaimed proposal stops continuation and repeated decline is idempotent', async () => {
    const batch = await startBatch();
    const input = { expectedRevision: batch.revision };
    expect(declineClientToolBatch(record, batch.id, input).idempotent).toBe(false);
    expect(declineClientToolBatch(record, batch.id, input).idempotent).toBe(true);
    await expect(running).rejects.toMatchObject({ code: 'confirmation_required' });
    expect(packets).toHaveLength(1);
});
test('cancellation retains an execution claim and prevents continuation or fresh claims', async () => {
    const batch = await startBatch();
    const input = { expectedRevision: batch.revision, executionId: 'exec' };
    claimClientToolBatch(record, batch.id, input);
    cancel(record);
    await expect(running).rejects.toMatchObject({ code: 'unknown' });
    expect(snapshot(record).toolBatches[0]).toMatchObject({ status: 'executing', executionId: 'exec' });
    expect(() => submitClientToolResults(record, batch.id, { ...input, results: [{ id: 'call-1', result: 'Found', isError: false }] })).toThrow('no live generation worker');
    expect(packets).toHaveLength(1);
    endGeneration(record);
    clearGenerations();
    const restored = getGeneration(record.requestId, 'owner', { root });
    expect(snapshot(restored).toolBatches[0].executionId).toBe('exec');
    expect(() => claimClientToolBatch(restored, batch.id, { ...input, executionId: 'new-exec' })).toThrow('no live generation worker');
});
test('catalog bounds and duplicate function identities are rejected', () => {
    expect(validateClientTools(tools)).toEqual(tools);
    expect(() => validateClientTools([...tools, ...tools])).toThrow('unique function');
    expect(() => validateClientTools([{ type: 'function', function: { name: 'invalid name', parameters: {} } }])).toThrow();
    expect(clientToolCatalogDigest(tools)).toBe(crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex'));
    const keyOrder = [{ 10: 'ten', 2: 'two', 1: 'one', a: 'last', 0: 'zero' }];
    expect(clientToolCatalogDigest(keyOrder)).toBe(crypto.createHash('sha256').update(JSON.stringify(keyOrder)).digest('hex'));
    expect(() => validateClientTools([{ type: 'function', function: { name: 'huge', parameters: { type: 'x'.repeat(262_145) } } }])).toThrow('256 KiB');
});
test('restoring an in-flight claimed journal yields an inspectable unknown outcome without execution authority', async () => {
    const batch = await startBatch();
    const input = { expectedRevision: batch.revision, executionId: 'exec' };
    claimClientToolBatch(record, batch.id, input);
    const journal = path.join(root, 'api-v1-generations', `${record.requestId}.json`);
    const interruptedBytes = fs.readFileSync(journal);
    cancel(record);
    await running.catch(() => {});
    endGeneration(record);
    clearGenerations();
    fs.writeFileSync(journal, interruptedBytes);
    const restored = getGeneration(record.requestId, 'owner', { root });
    expect(snapshot(restored)).toMatchObject({ status: 'unknown', drained: true, acknowledged: false,
        toolBatches: [{ status: 'executing', executionId: 'exec' }] });
    expect(claimClientToolBatch(restored, batch.id, input).dispatchAuthorized).toBe(false);
    expect(() => submitClientToolResults(restored, batch.id, { ...input, results: [{ id: 'call-1', result: 'Found', isError: false }] }))
        .toThrow('no live generation worker');
    expect(packets).toHaveLength(1);
});
test('the source recursion limit bounds tool execution and subsequent provider calls', async () => {
    repeatTools = true;
    let batch = await startBatch();
    for (let index = 0; index < 5; index++) {
        const input = { expectedRevision: batch.revision, executionId: `exec-${index}` };
        claimClientToolBatch(record, batch.id, input);
        submitClientToolResults(record, batch.id, { ...input, results: [{ id: 'call-1', result: 'Found', isError: false }] });
        if (index < 4) {
            for (let attempt = 0; attempt < 200 && record.toolBatches.length < index + 2; attempt++) await new Promise(done => setTimeout(done, 10));
            batch = record.toolBatches[index + 1];
            expect(batch).toBeDefined();
        }
    }
    await expect(running).rejects.toThrow('recursion limit');
    expect(record.toolBatches).toHaveLength(5);
    expect(packets).toHaveLength(6);
});
test('the public generation entry commits ordered ST invocation history and a reply after explicit receipts', async () => {
    cancel(record);
    endGeneration(record);
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    async function api(route, input, expected = 200) {
        const response = await fetch(base + route, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
        const body = await response.json();
        expect({ status: response.status, error: body.error ?? null }).toEqual({ status: expected, error: null });
        return body;
    }
    const input = { characterId: 'role', chatId: 'chat', clientRequestId: 'api-caller', type: 'normal', input: 'Question', tools };
    const preview = await api('/generations/preview', input);
    expect(preview.providerRequest.tools).toEqual(tools);
    expect(preview.warnings.tokenBudget.toolTokens).toBeGreaterThan(0);
    expect(packets).toHaveLength(0);
    const accepted = await api('/generations', input, 202);
    let state;
    for (let i = 0; i < 200; i++) {
        state = await api(`/generations/${accepted.requestId}`);
        if (state.toolBatches?.length) break;
        await new Promise(done => setTimeout(done, 10));
    }
    expect(state.toolBatches).toHaveLength(1);
    const batch = state.toolBatches[0];
    expect(batch.catalogRevision).toBe(clientToolCatalogDigest(tools));
    expect((await api('/generations', input, 202)).idempotent).toBe(true);
    const action = { expectedRevision: batch.revision, executionId: 'api-execution' };
    const route = `/generations/${accepted.requestId}/tool-batches/${batch.id}`;
    await api(`${route}/claim`, action);
    await api(`${route}/results`, { ...action, results: [{ id: 'call-1', result: 'Found record', isError: false }] });
    for (let i = 0; i < 200; i++) {
        state = await api(`/generations/${accepted.requestId}`);
        if (state.drained) break;
        await new Promise(done => setTimeout(done, 10));
    }
    expect(state).toMatchObject({ status: 'done', committed: true, drained: true });
    const rows = fs.readFileSync(path.join(directories.chats, 'role/chat.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows[1]).toMatchObject({ is_user: true, mes: 'Question' });
    expect(rows[2]).toMatchObject({ is_system: true, extra: { tool_invocations: [{ id: 'call-1', result: 'Found record' }] } });
    expect(rows[3]).toMatchObject({ is_user: false, mes: 'Found the answer.' });
    const nextPreview = await api('/generations/preview', { characterId: 'role', chatId: 'chat', type: 'normal', input: 'Next' });
    expect(nextPreview.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'tool', tool_call_id: 'call-1', content: 'Found record' }),
        expect.objectContaining({ role: 'assistant', content: 'Found the answer.' }),
    ]));
    expect(packets).toHaveLength(2);
});
