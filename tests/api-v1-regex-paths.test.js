import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { beforeAll, beforeEach, afterAll, describe, expect, test } from '@jest/globals';
import { router } from '../src/endpoints/api-v1.js';
import { clearGenerations } from '../src/headless/generation-store.js';
import { readSettings, writeSettings, writeChat, readChat } from '../src/headless/session.js';
import { setConfigFilePath } from '../src/util.js';
import { serverDirectory } from '../src/server-directory.js';
import { write as writeCard } from '../src/character-card-parser.js';

let root, directories, server, base, calls = 0, received, reply;
const filename = () => path.join(directories.chats, 'Aria/Chat.jsonl');
const script = (placement, findRegex, replaceString, extra = {}) => ({ placement: [placement], findRegex, replaceString, trimStrings: [], ...extra });
beforeAll(async () => {
    process.env.SILLYTAVERN_API_V1_ENABLED = 'true';
    setConfigFilePath(path.join(serverDirectory, 'default/config.yaml'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-regex-paths-'));
    directories = { root, worlds: path.join(root, 'worlds'), characters: path.join(root, 'characters'), chats: path.join(root, 'chats'), groups: path.join(root, 'groups'), groupChats: path.join(root, 'group-chats') };
    for (const dir of Object.values(directories)) fs.mkdirSync(dir, { recursive: true });
    const app = express(); app.use(express.json({ limit: '8mb' }));
    app.post('/provider/chat/completions', (req, res) => { calls++; received = req.body; res.type('text/event-stream').end('data: ' + JSON.stringify({ choices: [{ delta: { content: reply, reasoning_content: 'trace' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) + '\n\ndata: [DONE]\n\n'); });
    app.use((req, _res, next) => { req.user = { profile: { handle: 'regex-paths' }, directories }; next(); });
    app.use('/api/v1', router);
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
    clearGenerations(); calls = 0; received = null; reply = 'reply raw';
    fs.rmSync(path.join(root, 'api-v1-generations'), { recursive: true, force: true });
    fs.rmSync(directories.chats, { recursive: true, force: true });
    writeSettings(directories, { username: 'Reader', main_api: 'openai', oai_settings: { chat_completion_source: 'custom', custom_model: 'owned-regex', custom_url: base + '/provider', prompts: [{ identifier: 'main', content: 'Main' }], prompt_order: [], preset_settings_openai: 'Owned' }, power_user: { context: { story_string: '{{description}}' } }, extension_settings: { regex: [] } });
    card();
    writeChat(filename(), [{ chat_metadata: { variables: {} } }, { name: 'Aria', is_user: false, mes: 'Greeting raw' }]);
});
afterAll(async () => { clearGenerations(); delete process.env.SILLYTAVERN_API_V1_ENABLED; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
function card(extra = {}) { fs.writeFileSync(path.join(directories.characters, 'Aria.png'), writeCard(fs.readFileSync(path.join(serverDirectory, 'default/content/default_Seraphina.png')), JSON.stringify({ name: 'Aria', description: 'raw character field', ...extra }), { preserveSpec: true })); }
function configure(regex, more = {}) { const s = readSettings(directories); s.extension_settings = { ...s.extension_settings, regex, ...more }; writeSettings(directories, s); }
async function req(route, method = 'GET', body) {
    const response = await fetch(base + '/api/v1' + route, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
}
async function terminal(id) {
    for (let attempt = 0; attempt < 250; attempt++) {
        const value = (await req('/generations/' + id)).value;
        if (['done', 'error', 'unknown', 'cancelled'].includes(value.status) && value.drained !== false) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Generation did not drain');
}
const input = (clientRequestId = 'owned') => ({ clientRequestId, characterId: 'Aria', chatId: 'Chat', input: 'raw', type: 'normal' });
describe('source regex across storage, prompt, editing and read-only display', () => {
    test('group display applies regex without changing headerless transcript or raw messages', async () => {
        configure([script(2, '/raw/g', 'view', { markdownOnly: true })]);
        fs.writeFileSync(path.join(directories.groups, 'Display.json'), JSON.stringify({ name: 'Display', members: ['Aria.png'], disabled_members: [], chats: ['DisplayChat'], chat_id: 'DisplayChat' }));
        const file = path.join(directories.groupChats, 'DisplayChat.jsonl');
        const raw = JSON.stringify({ name: 'Aria', original_avatar: 'Aria.png', mes: 'raw', is_user: false });
        fs.writeFileSync(file, raw);
        const response = await req('/groups/Display/chats/DisplayChat/render', 'POST', {});
        expect(response.status).toBe(200);
        expect(response.value.messages).toMatchObject([{ index: 0, mes: 'raw' }]);
        expect(response.value.views).toMatchObject([{ index: 0, display: 'view' }]);
        expect(fs.readFileSync(file, 'utf8')).toBe(raw);
        fs.writeFileSync(file, JSON.stringify({ name: 'Missing', original_avatar: 'missing.png', mes: 'raw', is_user: false }));
        expect((await req('/groups/Display/chats/DisplayChat/render', 'POST', {})).status).toBe(422);
    });
    test('greetings apply standard global/authorized character/preset rules, never prompt/display-only rules', async () => {
        const rules = [script(2, '/greet/g', 'global'), script(2, '/global/g', 'display', { markdownOnly: true }), script(2, '/global/g', 'prompt', { promptOnly: true })];
        configure(rules); card({ extensions: { regex_scripts: [script(2, '/preset/g', 'scoped-final')] } });
        const s = readSettings(directories); s.oai_settings.extensions = { regex_scripts: [script(2, '/global/g', 'preset')] }; writeSettings(directories, s);
        expect((await req('/characters/Aria/chats', 'POST', { chatId: 'Global', firstMessage: 'greet' })).status).toBe(201);
        expect(readChat(path.join(directories.chats, 'Aria/Global.jsonl'))[1].mes).toBe('global');
        configure(rules, { character_allowed_regex: ['Aria.png'], preset_allowed_regex: { openai: ['Owned'] } });
        expect((await req('/characters/Aria/chats', 'POST', { chatId: 'Scoped', firstMessage: 'greet' })).status).toBe(201);
        expect(readChat(path.join(directories.chats, 'Aria/Scoped.jsonl'))[1].mes).toBe('scoped-final');
        configure(rules, { disabledExtensions: ['regex'] });
        await req('/characters/Aria/chats', 'POST', { chatId: 'Disabled', firstMessage: 'greet' });
        expect(readChat(path.join(directories.chats, 'Aria/Disabled.jsonl'))[1].mes).toBe('greet');
    });
    test('legacy global display placement is migrated without changing stored settings', async () => {
        const legacy = script(0, '/raw/g', 'legacy view');
        configure([legacy]);
        const before = readSettings(directories).extension_settings.regex;
        const rendered = await req('/chats/Chat?characterId=Aria&render=true');
        expect(rendered.status).toBe(200);
        expect(rendered.value.messages.at(-1).native_display).toBe('Greeting legacy view');
        expect(readSettings(directories).extension_settings.regex).toEqual(before);
        expect(readChat(filename()).at(-1).mes).toBe('Greeting raw');
    });
    test('editing card regex requires an independent grant before execution', async () => {
        const current = await req('/characters/Aria');
        const updated = structuredClone(current.value.raw);
        const data = updated.data ?? updated;
        data.extensions = { ...(data.extensions ?? {}), regex_scripts: [script(2, '/Scope raw/g', 'Scope authorized')] };
        const save = await req('/characters/Aria', 'PUT', { expectedRevision: current.value.revision, card: updated });
        expect(save.status).toBe(200);
        expect((await req('/regex-settings')).value.settings.characterAllowed).not.toContain('Aria.png');
        await req('/characters/Aria/chats', 'POST', { chatId: 'ScopeBefore', firstMessage: 'Scope raw' });
        expect(readChat(path.join(directories.chats, 'Aria/ScopeBefore.jsonl'))[1].mes).toBe('Scope raw');
        const settings = (await req('/regex-settings')).value;
        const grant = { ...settings.settings, characterAllowed: ['Aria.png'] };
        expect((await req('/regex-settings', 'PUT', { expectedRevision: settings.revision, settings: grant })).status).toBe(409);
        expect((await req('/regex-settings', 'PUT', { expectedRevision: settings.revision, settings: grant, confirmScopeChanges: true })).status).toBe(200);
        await req('/characters/Aria/chats', 'POST', { chatId: 'ScopeAfter', firstMessage: 'Scope raw' });
        expect(readChat(path.join(directories.chats, 'Aria/ScopeAfter.jsonl'))[1].mes).toBe('Scope authorized');
        expect((await req('/characters/Aria', 'PUT', { expectedRevision: current.value.revision, card: updated })).status).toBe(409);
    });
    test('input transforms once before storage, prompt-only rules respect roles, and output/reasoning use their own placements', async () => {
        configure([script(1, '/raw/g', 'stored {{incvar::n}}'), script(1, '/stored/g', 'request', { promptOnly: true }), script(2, '/Greeting/g', 'assistantPrompt', { promptOnly: true }), script(2, '/raw/g', 'AI {{incvar::out}}'), script(6, '/trace/g', 'reasoned')]);
        const before = fs.readFileSync(filename(), 'utf8');
        const preview = await req('/generations/preview', 'POST', input());
        expect(preview.status).toBe(200); expect(preview.value.messages).toContainEqual({ role: 'user', content: 'request 1' });
        expect(preview.value.messages.some(row => row.content === 'assistantPrompt raw')).toBe(true);
        expect(fs.readFileSync(filename(), 'utf8')).toBe(before); expect(calls).toBe(0);
        const accepted = await req('/generations', 'POST', input()); expect(accepted.status).toBe(202);
        const done = await terminal(accepted.value.requestId); expect(done.status).toBe('done'); expect(done.reasoning).toBe('reasoned'); expect(calls).toBe(1);
        expect(received.messages).toContainEqual({ role: 'user', content: 'request 1' });
        expect(received.messages.some(row => row.content === 'raw character field')).toBe(true);
        const saved = readChat(filename()); expect(saved.at(-2).mes).toBe('stored 1'); expect(saved.at(-1).mes).toBe('reply AI 1');
        expect(saved.at(-1).extra.reasoning).toBe('reasoned'); expect(saved[0].chat_metadata.variables).toMatchObject({ n: 1, out: 1 });
    });
    test('display-only transforms use full-history depth, retain raw text and discard variable effects on every read', async () => {
        configure([script(2, '/raw/g', 'stored-wrong'), script(2, '/raw/g', 'view {{incvar::views}}', { markdownOnly: true, minDepth: 1, maxDepth: 1 }), script(6, '/trace/g', 'display thought', { markdownOnly: true })]);
        writeChat(filename(), [{ chat_metadata: { variables: { views: 0 } } }, { is_user: false, mes: 'raw', extra: { reasoning: 'trace' } }, { is_system: true, mes: 'Hidden' }, { is_user: true, mes: 'raw' }]);
        const before = fs.readFileSync(filename(), 'utf8');
        for (let i = 0; i < 2; i++) {
            const rendered = await req('/chats/Chat?characterId=Aria&render=true&limit=1&after=0'); expect(rendered.status).toBe(200);
            const message = rendered.value.messages[0]; expect(message.index).toBe(1); expect(message.mes).toBe('raw'); expect(message.native_display).toBe('view 1'); expect(message.native_display_reasoning).toBe('display thought');
            expect(message.native_regex_warnings.join(' ')).toContain('never save');
            expect(fs.readFileSync(filename(), 'utf8')).toBe(before);
        }
        const raw = await req('/chats/Chat?characterId=Aria'); expect(raw.value.messages[1].native_display).toBeUndefined(); expect(calls).toBe(0);
    });
    test('native display context travels in a bounded POST body and does not execute preparation or write variables', async () => {
        configure([script(2, '/raw/g', '{{lastGenerationType}} {{input}}', { markdownOnly: true })]);
        const before = fs.readFileSync(filename(), 'utf8');
        const view = await req('/chats/Chat/render', 'POST', { characterId: 'Aria', nativeContext: { locale: 'zh-CN', timeZone: 'Asia/Shanghai', input: 'private draft', lastGenerationType: 'continue' } });
        expect(view.status).toBe(200); expect(view.value.messages[1].native_display).toBe('Greeting continue private draft');
        expect(fs.readFileSync(filename(), 'utf8')).toBe(before); expect(calls).toBe(0);
        expect((await req('/chats/Chat/render', 'POST', { characterId: 'Aria', nativeContext: { now: 0 } })).status).toBe(400);
    });
    test('regenerate and continue previews use their real history shape without dispatch or transcript mutation', async () => {
        const before = fs.readFileSync(filename(), 'utf8');
        const regenerate = await req('/generations/preview', 'POST', { characterId: 'Aria', chatId: 'Chat', type: 'regenerate' });
        expect(regenerate.status).toBe(200); expect(regenerate.value.messages.some(message => message.content === 'Greeting raw')).toBe(false);
        const continued = await req('/generations/preview', 'POST', { characterId: 'Aria', chatId: 'Chat', type: 'continue', input: 'Continue guidance' });
        expect(continued.status).toBe(200); expect(continued.value.messages.some(message => message.role === 'assistant' && message.content === 'Greeting raw')).toBe(true);
        expect(continued.value.messages.at(-1).content).toBe('Continue guidance');
        expect(fs.readFileSync(filename(), 'utf8')).toBe(before); expect(calls).toBe(0);
    });
    test('edit honors runOnEdit and captures/trim/macros, while append uses ordinary placement rules', async () => {
        configure([script(2, String.raw`/\[(?<word>.*?)\]/g`, '$<word>!', { runOnEdit: true, trimStrings: ['x'] }), script(2, '/old/g', 'must-not-run-on-edit')]);
        const route = '/chats/Chat/messages';
        expect((await req(route, 'POST', { characterId: 'Aria', action: 'edit', index: 1, message: { mes: '[xwordx] old {{user}}' } })).status).toBe(200);
        expect(readChat(filename())[1].mes).toBe('word! old Reader');
        expect((await req(route, 'POST', { characterId: 'Aria', action: 'append', message: { is_user: false, mes: 'old' } })).status).toBe(201);
        expect(readChat(filename()).at(-1).mes).toBe('must-not-run-on-edit');
    });
    test('concurrent greeting creators cannot overwrite a winner or publish a second set of variable effects', async () => {
        const responses = await Promise.all([1, 2].map(() => req('/characters/Aria/chats', 'POST', { chatId: 'Race', firstMessage: '{{incglobalvar::created}}' })));
        expect(responses.map(value => value.status).sort()).toEqual([201, 409]);
        expect(readSettings(directories).extension_settings.variables.global.created).toBe(1);
        expect(readChat(path.join(directories.chats, 'Aria/Race.jsonl'))[1].mes).toBe('1');
    });
    test('macro substitution in find patterns uses upstream escaped versus raw behavior', async () => {
        const s = readSettings(directories); s.username = 'Reader.*'; writeSettings(directories, s);
        configure([script(2, '/{{user}}/g', 'literal', { substituteRegex: 2 })]);
        expect((await req('/characters/Aria/chats', 'POST', { chatId: 'Escaped', firstMessage: 'ReaderXYZ Reader.*' })).status).toBe(201);
        expect(readChat(path.join(directories.chats, 'Aria/Escaped.jsonl'))[1].mes).toBe('ReaderXYZ literal');
        configure([script(2, '/{{user}}/g', 'raw', { substituteRegex: 1 })]);
        await req('/characters/Aria/chats', 'POST', { chatId: 'RawPattern', firstMessage: 'ReaderXYZ Reader.*' });
        expect(readChat(path.join(directories.chats, 'Aria/RawPattern.jsonl'))[1].mes).toBe('raw');
    });
    test('legacy regex placements can be inspected and saved with upstream migration', async () => {
        const legacy = [script(4, '/old/g', 'new'), script(0, '/raw/g', 'display')];
        configure(legacy);
        const original = await req('/regex-settings');
        expect(original.status).toBe(200);
        expect(original.value.settings.scripts[0].placement).toEqual([3]);
        expect(original.value.settings.scripts[1]).toMatchObject({ placement: [1, 2, 3, 5, 6], markdownOnly: true, promptOnly: true });
        expect(readSettings(directories).extension_settings.regex).toEqual(legacy);
        const saved = await req('/regex-settings', 'PUT', { expectedRevision: original.value.revision, settings: original.value.settings });
        expect(saved.status).toBe(200);
        expect(readSettings(directories).extension_settings.regex).toEqual(original.value.settings.scripts);
    });
    test('regex management requires explicit scope grants, independent revisions, and preserves unrelated settings', async () => {
        const original = (await req('/regex-settings')).value;
        expect(original.settings).toEqual({ enabled: true, scripts: [], characterAllowed: [], presetAllowed: {} });
        const document = { ...original.settings, characterAllowed: ['Aria.png'], presetAllowed: { openai: ['Owned'] } };
        expect((await req('/regex-settings', 'PUT', { expectedRevision: original.revision, settings: document })).value.error.code).toBe('confirmation_required');
        expect((await req('/regex-settings')).value).toEqual(original);
        const s = readSettings(directories); s.oai_settings.custom_model = 'Independently changed'; s.extension_settings.note = { keep: true }; s.extension_settings.disabledExtensions = ['owned-other']; writeSettings(directories, s);
        const saved = await req('/regex-settings', 'PUT', { expectedRevision: original.revision, settings: document, confirmScopeChanges: true }); expect(saved.status).toBe(200);
        expect(readSettings(directories)).toMatchObject({ oai_settings: { custom_model: 'Independently changed' }, extension_settings: { note: { keep: true }, disabledExtensions: ['owned-other'] } });
        expect((await req('/regex-settings', 'PUT', { expectedRevision: original.revision, settings: document, confirmScopeChanges: true })).status).toBe(409);
        const disabled = await req('/regex-settings', 'PUT', { expectedRevision: saved.value.revision, settings: { ...document, enabled: false } }); expect(disabled.status).toBe(200);
        expect((await req('/regex-settings', 'PUT', { expectedRevision: disabled.value.revision, settings: document })).value.error.code).toBe('confirmation_required');
        const revoked = await req('/regex-settings', 'PUT', { expectedRevision: disabled.value.revision, settings: { ...document, enabled: true, characterAllowed: [], presetAllowed: {} } }); expect(revoked.status).toBe(200);
        expect(readSettings(directories).extension_settings.disabledExtensions).toEqual(['owned-other']); expect(calls).toBe(0);
    });
    test.each([{ scripts: {} }, { scripts: [{ findRegex: '/a/', replaceString: 'b', placement: [4] }] }, { scripts: [{ findRegex: '/a/', replaceString: 'b', placement: [2], runOnEdit: 'yes' }] }, { characterAllowed: ['../escape'] }, { characterAllowed: ['Aria.png', 'Aria.png'] }, { presetAllowed: { openai: 'Owned' } }, { enabled: 'true' }, { confirmScopeChanges: true }])('malformed regex settings cannot replace existing state: %j', async patch => {
        const before = (await req('/regex-settings')).value;
        const result = await req('/regex-settings', 'PUT', { expectedRevision: before.revision, settings: { ...before.settings, ...patch }, confirmScopeChanges: true });
        expect(result.status).toBe(400); expect((await req('/regex-settings')).value).toEqual(before);
    });
    test('corrupt or oversized stored regex settings remain visible errors rather than empty-state fallbacks', async () => {
        const s = readSettings(directories); s.extension_settings.disabledExtensions = 'regex'; writeSettings(directories, s);
        expect((await req('/regex-settings')).status).toBe(422);
        s.extension_settings.disabledExtensions = []; s.extension_settings.regex = [script(2, '/a/', 'x'.repeat(1_048_576))]; writeSettings(directories, s);
        expect((await req('/regex-settings')).status).toBe(422);
    });
    test('cancelling while output regex is bounded retains raw output and never publishes computed variable effects or replays a provider', async () => {
        reply = 'a'.repeat(12000) + '!';
        configure([script(2, '/^/', '{{setglobalvar::mustNotPublish::yes}}'), script(2, '/(a+)+$/', '')]);
        const accepted = await req('/generations', 'POST', input()); expect(accepted.status).toBe(202);
        const id = accepted.value.requestId;
        for (let i = 0; i < 100; i++) { if ((await req('/generations/' + id)).value.text?.endsWith('!')) break; await new Promise(resolve => setTimeout(resolve, 20)); }
        const start = Date.now(); expect((await req('/capabilities')).status).toBe(200); expect(Date.now() - start).toBeLessThan(2000);
        await req('/generations/' + id + '/cancel', 'POST', {});
        const stopped = await terminal(id); expect(['unknown', 'cancelled']).toContain(stopped.status); expect(stopped.committed).toBe(false); expect(stopped.text).toBe(reply);
        expect(readSettings(directories).extension_settings.variables?.global?.mustNotPublish).toBeUndefined(); expect(readChat(filename())).toHaveLength(2); expect(calls).toBe(1);
        configure([]);
        expect((await req('/characters/Aria/chats', 'POST', { chatId: 'AfterWorkerRestart', firstMessage: 'Healthy' })).status).toBe(201);
    }, 25000);
    test('an output-formatting timeout without cancellation is billable-unknown and caller-key observation never replays it', async () => {
        reply = 'a'.repeat(12000) + '!'; configure([script(2, '/(a+)+$/', '')]);
        const accepted = await req('/generations', 'POST', input()); expect(accepted.status).toBe(202);
        const stopped = await terminal(accepted.value.requestId);
        expect(stopped.status).toBe('unknown'); expect(stopped.error.message).toContain('may have been billed');
        expect(stopped.text).toBe(reply); expect(stopped.committed).toBe(false); expect(readChat(filename())).toHaveLength(2);
        expect(stopped.reasoning).toBe('trace'); expect(stopped.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
        const duplicate = await req('/generations', 'POST', input());
        expect(duplicate.value.requestId).toBe(accepted.value.requestId); expect(duplicate.value.idempotent).toBe(true); expect(calls).toBe(1);
    }, 25000);
});
