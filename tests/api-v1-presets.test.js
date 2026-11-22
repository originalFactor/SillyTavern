import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { router } from '../src/endpoints/api-v1.js';
import { readSettings, writeSettings } from '../src/headless/session.js';
import { PRESET_CONNECTION_FIELDS, PRESET_SETTING_KEYS } from '../src/headless/preset-mapping.js';
import { DEFAULT_USER, USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';
import { serverDirectory } from '../src/server-directory.js';
import { createMacroContext } from '../src/headless/macros.js';
import { assembleTextPrompt } from '../src/headless/text-runtime/index.js';

let root, dirs, server, base;
beforeAll(async () => {
    process.env.SILLYTAVERN_API_V1_ENABLED = 'true';
    setConfigFilePath(path.join(serverDirectory, 'default/config.yaml'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-presets-'));
    dirs = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, value)]));
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    writeSettings(dirs, { main_api: 'openai', future: { keep: true }, oai_settings: { chat_completion_source: 'custom', custom_url: 'https://original.invalid/v1', custom_model: 'original-model', custom_include_headers: 'Authorization: Bearer original-secret', temp_openai: 0.7 }, power_user: { instruct: { enabled: false } } });
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((req, _res, next) => { req.user = { profile: { ...DEFAULT_USER, handle: 'preset-test' }, directories: dirs }; next(); });
    app.use('/api/v1', router);
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
afterAll(async () => { delete process.env.SILLYTAVERN_API_V1_ENABLED; await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
async function request(url, method = 'GET', body) {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
}
const presetPath = (kind, name) => `/presets/${kind}/${encodeURIComponent(name)}`;

describe('native named presets', () => {
    test('uses exactly the upstream preset/settings aliases and connection consent fields', () => {
        const source = fs.readFileSync(path.join(serverDirectory, 'public/scripts/openai.js'), 'utf8');
        const start = source.indexOf('export const settingsToUpdate = {');
        const block = source.slice(start, source.indexOf('\n};', start));
        const rows = [...block.matchAll(/^\s*(\w+): \['[^']*', '([^']+)', (true|false), (true|false)\]/gm)];
        expect(Object.fromEntries(rows.map(row => [row[1], row[2]]))).toEqual(PRESET_SETTING_KEYS);
        expect(new Set(rows.filter(row => row[4] === 'true').map(row => row[1]))).toEqual(PRESET_CONNECTION_FIELDS);
    });
    test('bundled templates are listed without requiring the browser SPA', async () => {
        for (const kind of ['chat-completion', 'context', 'instruct', 'sysprompt']) {
            const result = await request(`/presets/${kind}`);
            expect(result.status).toBe(200);
            expect(result.body.presets.some(preset => preset.origin === 'builtin')).toBe(true);
        }
    });
    test('snapshots current settings using upstream aliases and omits credential-bearing headers', async () => {
        const result = await request('/preset-settings/chat-completion');
        expect(result.body.preset.temperature).toBe(0.7);
        expect(result.body.preset.custom_model).toBe('original-model');
        expect(result.body.preset.custom_include_headers).toBeUndefined();
        expect(JSON.stringify(result.body)).not.toContain('original-secret');
    });
    test('creates Unicode presets, rejects accidental overwrites, preserves opaque fields and exports portable JSON', async () => {
        const url = presetPath('chat-completion', '原生预设 🙂');
        const preset = { temperature: 0.4, custom_model: 'new-model', vendor: { keep: [1, 2] }, prompts: [{ identifier: 'main', content: '[redacted]', role: 'system' }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }] };
        const created = await request(url, 'PUT', { preset });
        expect(created.status).toBe(200);
        expect(created.body.preset).toEqual(preset);
        expect((await request(url, 'PUT', { preset })).status).toBe(409);
        const changed = await request(url, 'PUT', { preset: { ...preset, temperature: 0.5 }, expectedRevision: created.body.revision });
        expect(changed.status).toBe(200);
        expect((await request(url, 'PUT', { preset, expectedRevision: created.body.revision })).status).toBe(409);
        const exported = await request(url + '/export');
        expect(JSON.parse(Buffer.from(exported.body.dataBase64, 'base64').toString())).toEqual({ ...preset, temperature: 0.5 });
        const catalog = (await request('/presets/chat-completion')).body;
        expect((await request(url + '/activate', 'POST', { expectedRevision: changed.body.revision, expectedActiveRevision: catalog.activeRevision })).status).toBe(409);
        const activated = await request(url + '/activate', 'POST', { expectedRevision: changed.body.revision, expectedActiveRevision: catalog.activeRevision, allowConnectionChanges: true });
        expect(activated.status).toBe(200);
        const saved = readSettings(dirs);
        expect(saved.oai_settings.temp_openai).toBe(0.5);
        expect(saved.oai_settings.custom_model).toBe('new-model');
        expect(saved.oai_settings.custom_include_headers).toContain('original-secret');
        expect(saved.future.keep).toBe(true);
        expect(saved.oai_settings.prompts[0].content).toBe('[redacted]');
        expect((await request(url, 'DELETE')).status).toBe(409);
    });
    test('detects changes to active provider settings between inspect and select', async () => {
        const url = presetPath('chat-completion', 'Race');
        const created = (await request(url, 'PUT', { preset: { temperature: 0.8 } })).body;
        const catalog = (await request('/presets/chat-completion')).body;
        const settings = readSettings(dirs); settings.oai_settings.custom_model = 'changed-independently'; writeSettings(dirs, settings);
        expect((await request(url + '/activate', 'POST', { expectedRevision: created.revision, expectedActiveRevision: catalog.activeRevision, allowConnectionChanges: true })).status).toBe(409);
        expect(readSettings(dirs).oai_settings.custom_model).toBe('changed-independently');
        expect((await request(url + '?expectedRevision=' + created.revision, 'DELETE')).status).toBe(200);
    });
    test('built-in presets cannot be deleted but can be overridden after inspection', async () => {
        const url = presetPath('context', 'Default');
        const builtin = (await request(url)).body;
        expect((await request(url + '?expectedRevision=' + builtin.revision, 'DELETE')).status).toBe(409);
        const saved = await request(url, 'PUT', { expectedRevision: builtin.revision, preset: { ...builtin.preset, future: { keep: true } } });
        expect(saved.body.origin).toBe('user');
        expect((await request(url + '?expectedRevision=' + saved.body.revision, 'DELETE')).status).toBe(200);
        expect((await request(url)).body.origin).toBe('builtin');
    });
    test('selects instruct templates without enabling unsupported instruct mode', async () => {
        const preset = (await request(presetPath('instruct', 'Alpaca'))).body;
        const catalog = (await request('/presets/instruct')).body;
        const result = await request(presetPath('instruct', 'Alpaca') + '/activate', 'POST', { expectedRevision: preset.revision, expectedActiveRevision: catalog.activeRevision });
        expect(result.status).toBe(200);
        expect(result.body.activeName).toBe('Alpaca');
        expect(readSettings(dirs).power_user.instruct.preset).toBe('Alpaca');
        expect(readSettings(dirs).power_user.instruct.enabled).toBe(false);
    });
    test('changes the text Instruct switch with a revision fence and preserves other settings', async () => {
        const original = (await request('/preset-settings/instruct')).body;
        expect((await request('/instruct-mode', 'PUT', { expectedRevision: original.revision, enabled: 'true' })).status).toBe(400);
        const enabled = await request('/instruct-mode', 'PUT', { expectedRevision: original.revision, enabled: true });
        expect(enabled.status).toBe(200);
        expect(enabled.body.preset.enabled).toBe(true);
        expect(readSettings(dirs).power_user.instruct.preset).toBe('Alpaca');
        expect(readSettings(dirs).future.keep).toBe(true);
        const settings = readSettings(dirs);
        settings.main_api = 'textgenerationwebui';
        settings.max_context = 2048;
        settings.amount_gen = 64;
        const history = [{ name: 'Reader', is_user: true, mes: 'Question' }];
        const session = { userName: 'Reader', directories: dirs, extensionSettings: {}, settings };
        const context = createMacroContext(session, { name: 'Aria' }, [{ chat_metadata: {} }, ...history]);
        const result = await assembleTextPrompt(context, {}, history, [], {});
        expect(result.prompt).toContain(settings.power_user.instruct.input_sequence);
        expect((await request('/instruct-mode', 'PUT', { expectedRevision: original.revision, enabled: false })).status).toBe(409);
        expect((await request('/instruct-mode', 'PUT', { expectedRevision: enabled.body.revision, enabled: false })).status).toBe(200);
    });
    test('rejects malformed, credential-bearing and traversal imports before writing', async () => {
        for (const preset of [[], null, { temperature: 'bad' }, { apiKey: 'secret' }, { extensions: { secret: { value: 'secret' } } }, { custom_include_headers: { Authorization: 'hidden' } }, { prompts: [] }]) {
            expect((await request(presetPath('chat-completion', 'invalid'), 'PUT', { preset })).status).toBe(400);
        }
        expect((await request(presetPath('chat-completion', '..escape'), 'PUT', { preset: {} })).status).toBe(400);
        expect((await request(presetPath('chat-completion', 'invalid'))).status).toBe(404);
    });
    test('legacy prompt presets migrate their main and post-history instructions', async () => {
        const url = presetPath('chat-completion', 'Legacy migration');
        const created = (await request(url, 'PUT', { preset: { main_prompt: 'Legacy main', jailbreak_prompt: 'Legacy end', temperature: 0.6 } })).body;
        const catalog = (await request('/presets/chat-completion')).body;
        expect((await request(url + '/activate', 'POST', { expectedRevision: created.revision, expectedActiveRevision: catalog.activeRevision })).status).toBe(200);
        const settings = readSettings(dirs);
        expect(settings.oai_settings.prompts.find(prompt => prompt.identifier === 'main').content).toBe('Legacy main');
        expect(settings.oai_settings.prompts.find(prompt => prompt.identifier === 'jailbreak').content).toBe('Legacy end');
        expect(settings.oai_settings.temp_openai).toBe(0.6);
    });
    test('settings reads do not reveal configured headers or URL passwords', async () => {
        const stored = readSettings(dirs);
        stored.oai_settings.custom_url = 'https://reader:private-password@example.invalid/v1';
        writeSettings(dirs, stored);
        const result = await request('/settings');
        expect(JSON.stringify(result.body)).not.toContain('private-password');
        expect(JSON.stringify(result.body)).not.toContain('original-secret');
        expect(readSettings(dirs).oai_settings.custom_url).toContain('private-password');
    });
    test('typed settings include the redacted text completion profile and output budget', async () => {
        const stored = readSettings(dirs);
        stored.main_api = 'textgenerationwebui';
        stored.amount_gen = 123;
        stored.textgenerationwebui_settings = { type: 'generic', generic_model: 'model-x', temp: 0.42, server_urls: { generic: 'https://user:secret@example.invalid' } };
        writeSettings(dirs, stored);
        const response = await request('/settings');
        expect(response.body.typed.amount_gen).toBe(123);
        expect(response.body.typed.textgenerationwebui_settings).toMatchObject({ type: 'generic', generic_model: 'model-x', temp: 0.42 });
        expect(JSON.stringify(response.body)).not.toContain('secret');
    });
    test('never serves credential fields from existing upstream presets', async () => {
        fs.writeFileSync(path.join(dirs.openAI_Settings, 'legacy-secret.json'), JSON.stringify({ proxy_password: 'hidden-provider-password', custom_include_headers: 'Authorization: Bearer private', temperature: 0.2 }));
        const result = await request(presetPath('chat-completion', 'legacy-secret'));
        expect(result.body.credentialsRedacted).toBe(true);
        expect(JSON.stringify(result.body)).not.toContain('hidden-provider-password');
        const exported = await request(presetPath('chat-completion', 'legacy-secret') + '/export');
        expect(JSON.parse(Buffer.from(exported.body.dataBase64, 'base64').toString())).toEqual({ temperature: 0.2 });
    });
});
