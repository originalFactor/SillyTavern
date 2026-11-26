import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { router } from '../dist/src/endpoints/api-v1.js';
import { readSettings, writeSettings } from '../dist/src/headless/session.js';
import { invalidateProviderStatus, readProviderStatus } from '../dist/src/headless/provider-status.js';
import { USER_DIRECTORY_TEMPLATE } from '../dist/src/constants.js';
import { setConfigFilePath } from '../dist/src/util.js';

let root, directories, apiServer, provider, apiBase, providerBase, respond, previousEnabled;
let calls = [];
let writeSecret, SECRET_KEYS;
const key = 'private-status-test-key';
beforeAll(async () => {
    previousEnabled = process.env.SILLYTAVERN_API_V1_ENABLED;
    process.env.SILLYTAVERN_API_V1_ENABLED = 'true';
    setConfigFilePath(path.resolve('default/config.yaml'));
    ({ writeSecret, SECRET_KEYS } = await import('../dist/src/endpoints/secrets.js'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-provider-status-'));
    directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([name, value]) => [name, path.join(root, value)]));
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    const remote = express();
    remote.use((req, res) => { calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization }); respond(req, res); });
    provider = await new Promise(resolve => { const listening = remote.listen(0, '127.0.0.1', () => resolve(listening)); });
    providerBase = `http://127.0.0.1:${provider.address().port}/v1`;
    const app = express(); app.use(express.json({ strict: false }));
    app.use((req, _res, next) => { req.user = { directories, profile: { handle: 'status-owner' } }; next(); });
    app.use('/api/v1', router);
    apiServer = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    apiBase = `http://127.0.0.1:${apiServer.address().port}/api/v1`;
});
beforeEach(() => {
    invalidateProviderStatus({ directories }); calls = [];
    respond = (_req, res) => res.json({ data: [{ id: 'model' }] });
    writeSettings(directories, { main_api: 'openai', username: 'User', oai_settings: { chat_completion_source: 'custom', custom_url: providerBase, custom_model: 'model' } });
    writeSecret(directories, SECRET_KEYS.CUSTOM, key);
});
afterAll(async () => {
    invalidateProviderStatus({ directories });
    for (const server of [apiServer, provider]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (previousEnabled === undefined) delete process.env.SILLYTAVERN_API_V1_ENABLED; else process.env.SILLYTAVERN_API_V1_ENABLED = previousEnabled;
});
async function request(route = '/provider-status', method = 'GET', body) {
    const response = await fetch(apiBase + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json(), cache: response.headers.get('cache-control') };
}
const check = () => request('/provider-status/check', 'POST', {});
const change = patch => writeSettings(directories, { ...readSettings(directories), ...patch });

describe('observed provider connection status', () => {
    test('advertises the contract and GET never infers success or dispatches from settings, keys or unrelated model discovery', async () => {
        expect((await request('/capabilities')).value.resources.providerStatus).toBe(true);
        expect(await request()).toMatchObject({ status: 200, cache: 'no-store', value: { onlineStatus: 'no_connection', state: 'unchecked', checkedAt: null } });
        expect(calls).toHaveLength(0);
        expect((await request('/provider-models', 'POST', { baseUrl: providerBase })).status).toBe(200);
        expect((await request()).value.state).toBe('unchecked'); expect(calls).toHaveLength(1);
    });
    test('checks only the saved endpoint with the matching key and publishes a bounded, ephemeral result', async () => {
        const settings = fs.readFileSync(path.join(directories.root, 'settings.json'));
        const result = await check();
        expect(result).toMatchObject({ status: 200, cache: 'no-store', value: { onlineStatus: 'Valid', state: 'valid' } });
        expect(Number.isSafeInteger(result.value.checkedAt)).toBe(true);
        expect(Object.keys(result.value).sort()).toEqual(['checkedAt', 'onlineStatus', 'state']);
        expect(JSON.stringify(result.value)).not.toContain(key); expect(JSON.stringify(result.value)).not.toContain(providerBase);
        expect(calls).toEqual([{ method: 'GET', url: '/v1/models', authorization: `Bearer ${key}` }]);
        expect((await request()).value).toEqual(result.value);
        expect(calls).toHaveLength(1); expect(fs.readFileSync(path.join(directories.root, 'settings.json'))).toEqual(settings);
        invalidateProviderStatus({ directories }); expect((await request()).value.state).toBe('unchecked');
    });
    test('does not share a successful observation with another authenticated user directory', async () => {
        expect((await check()).status).toBe(200);
        const other = { ...directories, root: path.join(root, 'other-user') }; fs.mkdirSync(other.root);
        writeSettings(other, readSettings(directories)); writeSecret(other, SECRET_KEYS.CUSTOM, key);
        expect(await readProviderStatus({ directories: other })).toMatchObject({ state: 'unchecked', onlineStatus: 'no_connection' });
        expect((await request()).value.state).toBe('valid'); expect(calls).toHaveLength(1);
    });
    test('credential deletion clears success and never performs an implicit recheck', async () => {
        expect((await check()).status).toBe(200);
        expect((await request('/provider-credentials/custom', 'DELETE')).status).toBe(200);
        expect((await request()).value.state).toBe('unchecked'); expect((await check()).status).toBe(409); expect(calls).toHaveLength(1);
    });
    test('rejects argument injection and unsupported or invalid configured connections before network access', async () => {
        for (const input of [null, [], { url: providerBase }, { baseUrl: providerBase }, { provider: 'openai' }, { headers: { Authorization: key } }]) expect((await request('/provider-status/check', 'POST', input)).status).toBe(400);
        for (const value of ['file:///etc/passwd', 'https://user:pass@example.test', 'https://example.test?q=secret', 'https://example.test#fragment', 'invalid']) {
            change({ oai_settings: { chat_completion_source: 'custom', custom_url: value } });
            expect((await check()).status).toBe(422); expect((await request()).value.onlineStatus).toBe('no_connection');
        }
        change({ oai_settings: { chat_completion_source: 'claude' } }); expect((await check()).status).toBe(422);
        change({ main_api: 'textgenerationwebui' }); expect((await check()).status).toBe(422);
        change({ main_api: 'openai', oai_settings: { chat_completion_source: 'openai' } });
        expect((await check()).status).toBe(409); expect(calls).toHaveLength(0);
    });
    test('does not follow redirects, retries or provider error bodies containing credentials', async () => {
        respond = (_req, res) => res.status(302).set('Location', '/leaked').send(`rejected ${key}`);
        const result = await check();
        expect(result).toMatchObject({ status: 502, cache: 'no-store' });
        expect(result.value.error.message).toContain('302'); expect(JSON.stringify(result.value)).not.toContain(key);
        expect(calls).toHaveLength(1);
        expect((await request()).value).toMatchObject({ onlineStatus: 'no_connection', state: 'failed' });
        expect(calls).toHaveLength(1);
    });
    test.each(['invalid-json', 'provider-error', 'invalid-catalog', 'too-many-models', 'oversized', 'interrupted'])('fails closed for %s responses', async mode => {
        respond = (_req, res) => {
            if (mode === 'invalid-json') return res.end('{');
            if (mode === 'provider-error') return res.json({ data: [], error: key });
            if (mode === 'invalid-catalog') return res.json({ data: [{ id: '' }] });
            if (mode === 'too-many-models') return res.json({ data: Array(2001).fill({ id: 'model' }) });
            if (mode === 'oversized') return res.json({ data: [], extra: 'x'.repeat(2_097_153) });
            res.socket.destroy();
        };
        const result = await check(); expect(result.status).toBe(502); expect(JSON.stringify(result.value)).not.toContain(key);
        expect((await request()).value).toMatchObject({ onlineStatus: 'no_connection', state: 'failed' }); expect(calls).toHaveLength(1);
    });
    test('expires a successful observation after five minutes without an automatic check', async () => {
        const result = await check();
        const clock = jest.spyOn(Date, 'now').mockReturnValue(result.value.checkedAt + 300_000);
        try { expect((await request()).value).toMatchObject({ state: 'unchecked', onlineStatus: 'no_connection' }); }
        finally { clock.mockRestore(); }
        expect(calls).toHaveLength(1);
    });
    test.each(['model', 'url', 'key'])('invalidates success when the configured %s changes', async field => {
        expect((await check()).status).toBe(200);
        if (field === 'key') writeSecret(directories, SECRET_KEYS.CUSTOM, 'replacement-key');
        else change({ oai_settings: { ...readSettings(directories).oai_settings, [field === 'url' ? 'custom_url' : 'custom_model']: 'changed' } });
        expect((await request()).value).toMatchObject({ state: 'unchecked', onlineStatus: 'no_connection' }); expect(calls).toHaveLength(1);
    });
    test.each(['settings', 'credentials'])('rejects concurrent checks and prevents late success after %s change', async mode => {
        let release, reached; const hit = new Promise(resolve => { reached = resolve; });
        respond = (_req, res) => { release = () => res.json({ data: [] }); reached(); };
        const pending = check(); await hit;
        expect((await request()).value.state).toBe('checking');
        expect((await check()).status).toBe(409);
        if (mode === 'settings') change({ oai_settings: { chat_completion_source: 'custom', custom_url: providerBase, custom_model: 'new-model' } });
        else expect((await request('/provider-credentials', 'PUT', { provider: 'custom', apiKey: 'new-key' })).status).toBe(200);
        release(); expect((await pending).status).toBe(409);
        expect((await request()).value.state).toBe('unchecked'); expect(calls).toHaveLength(1);
    });
    test('a discarded check cannot overwrite a newer successful observation', async () => {
        let release, reached; const hit = new Promise(resolve => { reached = resolve; });
        respond = (_req, res) => { release = () => res.json({ data: [] }); reached(); };
        const old = check(); await hit;
        change({ oai_settings: { ...readSettings(directories).oai_settings, custom_model: 'changed' } });
        expect((await request()).value.state).toBe('unchecked');
        respond = (_req, res) => res.json({ data: [] });
        const fresh = await check(); expect(fresh.status).toBe(200); expect(fresh.value.state).toBe('valid');
        release(); expect((await old).status).toBe(409);
        expect((await request()).value).toEqual(fresh.value); expect(calls).toHaveLength(2);
    });
    test('times out an explicit stalled check without replay or retaining success', async () => {
        respond = () => {};
        expect((await check()).status).toBe(502);
        expect((await request()).value.state).toBe('failed'); expect(calls).toHaveLength(1);
    }, 15_000);
});
