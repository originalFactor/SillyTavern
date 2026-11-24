import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { router as apiV1Router } from '../../../src/endpoints/api-v1.js';
import { clearGenerations } from '../../../src/headless/generation-store.js';
import { writeSettings } from '../../../src/headless/session.js';
import { write as writePngMetadata } from '../../../src/character-card-parser.js';
import { USER_DIRECTORY_TEMPLATE, DEFAULT_USER } from '../../../src/constants.js';
import { serverDirectory } from '../../../src/server-directory.js';
import { setConfigFilePath } from '../../../src/util.js';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-api-v1-'));
setConfigFilePath(path.join(serverDirectory, 'default', 'config.yaml'));
const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(dataRoot, value)]));
for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });

const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    name: 'Test Character',
    data: {
        name: 'Test Character',
        description: 'A test character for {{user}}.',
        personality: 'Helpful',
        scenario: 'A contract test',
        first_mes: 'Hello {{user}}!',
        mes_example: '{{user}}: Hi\n{{char}}: Hello',
    },
};
const png = fs.readFileSync(path.join(serverDirectory, 'default', 'content', 'default_Seraphina.png'));
fs.writeFileSync(path.join(directories.characters, 'Test Character.png'), writePngMetadata(png, JSON.stringify(card)));
fs.mkdirSync(path.join(directories.chats, 'Test Character'), { recursive: true });
fs.writeFileSync(path.join(directories.chats, 'Test Character', 'Conversation.jsonl'), [
    JSON.stringify({ chat_metadata: {} }),
    JSON.stringify({ name: 'Test Character', is_user: false, mes: 'Hello!', send_date: new Date().toISOString() }),
].join('\n'));
fs.mkdirSync(path.join(directories.extensions, 'contract-extension'), { recursive: true });
fs.writeFileSync(path.join(directories.extensions, 'contract-extension', 'manifest.json'), JSON.stringify({
    display_name: 'Contract Extension',
    version: '1.0.0',
    runtime: 'webview',
    ui: 'settings.html',
    capabilities: ['extensionSettings'],
    hooks: { activate: 'init' },
}));
fs.writeFileSync(path.join(directories.extensions, 'contract-extension', 'settings.html'), '<h1>Extension</h1>');

// A trusted headless extension demonstrating the compatibility layer. Enable with
// SILLYTAVERN_API_V1_HEADLESSPLUGINS=true to see its prompt injection and suffix.
const headlessDir = path.join(directories.extensions, 'contract-headless');
fs.mkdirSync(headlessDir, { recursive: true });
fs.writeFileSync(path.join(headlessDir, 'manifest.json'), JSON.stringify({
    display_name: 'Contract Headless',
    version: '1.0.0',
    runtime: 'headless',
    entry: 'index.mjs',
    hooks: { beforePrompt: 'beforePrompt', afterGeneration: 'afterGeneration' },
}));
fs.writeFileSync(path.join(headlessDir, 'index.mjs'), `
export async function beforePrompt(context) {
    context.messages.push({ role: 'system', content: 'HEADLESS-PROMPT-ACTIVE' });
}
export async function afterGeneration(context) {
    context.generation.text += ' [headless]';
}
`);

const defaultSettings = JSON.parse(fs.readFileSync(path.join(serverDirectory, 'default', 'content', 'settings.json'), 'utf8'));
defaultSettings.username = 'Native User';
defaultSettings.main_api = 'openai';
defaultSettings.oai_settings.chat_completion_source = 'custom';
defaultSettings.oai_settings.custom_model = 'mock-model';
defaultSettings.oai_settings.custom_url = process.env.ST_API_V1_MOCK_URL ?? 'http://127.0.0.1:3999/v1';
defaultSettings.oai_settings.stream_openai = true;
defaultSettings.world_info_settings.world_info.globalSelect = ['Contract World'];
defaultSettings.extension_settings.regex = [{ findRegex: 'Hi(.*)', replaceString: 'Greetings$1', placement: 1 }];
writeSettings(directories, defaultSettings);
fs.writeFileSync(path.join(directories.worlds, 'Contract World.json'), JSON.stringify({
    name: 'Contract World',
    entries: {
        lore: { id: 1, key: ['A contract test'], content: 'The setting is a contract test.', order: 100, position: 0 },
    },
}));

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((request, _response, next) => {
    request.user = { profile: { ...DEFAULT_USER, handle: 'contract-user' }, directories };
    next();
});
app.use('/api/v1', apiV1Router);

const server = app.listen(Number(process.env.PORT ?? 3998), '127.0.0.1', () => {
    console.log(JSON.stringify({ port: server.address().port, dataRoot }));
});

function shutdown() {
    clearGenerations();
    server.close(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
