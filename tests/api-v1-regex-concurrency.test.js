import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest, beforeAll, beforeEach, afterEach, expect, test } from '@jest/globals';
import { setConfigFilePath } from '../src/util.js';
import { serverDirectory } from '../src/server-directory.js';
import { readChat, writeChat } from '../src/headless/session.js';
import { clearGenerations, createGeneration } from '../src/headless/generation-store.js';
import { write as writeCard } from '../src/character-card-parser.js';

let enter, resolve, entered;
jest.unstable_mockModule('../src/headless/prompt.js', () => ({ runNativeText: () => { enter(); return new Promise(done => { resolve = done; }); } }));
const { mutateNativeMessage } = await import('../src/headless/message-text.js');
let root, session, file, pending;
beforeAll(() => setConfigFilePath(path.join(serverDirectory, 'default/config.yaml')));
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-regex-edit-fence-'));
    session = { handle: 'regex-editor', directories: { root, characters: path.join(root, 'characters'), chats: path.join(root, 'chats') } };
    fs.mkdirSync(session.directories.characters);
    fs.writeFileSync(path.join(session.directories.characters, 'Aria.png'), writeCard(fs.readFileSync(path.join(serverDirectory, 'default/content/default_Seraphina.png')), JSON.stringify({ name: 'Aria' }), { preserveSpec: true }));
    file = path.join(session.directories.chats, 'Aria/Chat.jsonl');
    writeChat(file, [{ chat_metadata: { variables: { keep: 1 } } }, { is_user: false, mes: 'Original', extra: { opaque: true } }]);
    entered = new Promise(done => { enter = done; });
    pending = null;
});
afterEach(async () => { if (pending) await pending.catch(() => {}); clearGenerations(); fs.rmSync(root, { recursive: true, force: true }); });
function result() { return { text: 'Transformed', macroEffects: { localDirty: true, globalDirty: false, metadata: { variables: { keep: 1, computed: 1 } } }, warnings: { macroWarnings: [], regexWarnings: [] } }; }
function edit() { return mutateNativeMessage(session, 'Aria', 'Chat', { action: 'edit', index: 1, message: { mes: 'Draft' } }); }
test('a newer transcript row or metadata update wins over a suspended regex edit without publishing computed effects', async () => {
    pending = edit(); await entered;
    const changed = readChat(file); changed[0].chat_metadata.variables.keep = 2; changed.push({ is_user: true, mes: 'Independent' }); writeChat(file, changed);
    const bytes = fs.readFileSync(file, 'utf8'); resolve(result());
    await expect(pending).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
});
test('a generation admitted while regex editing is suspended fences both the text and metadata publication', async () => {
    pending = edit(); await entered;
    createGeneration({ handle: session.handle, characterId: 'Aria', chatId: 'Chat', clientRequestId: 'admitted-during-edit', type: 'normal', directories: session.directories });
    const bytes = fs.readFileSync(file, 'utf8'); resolve(result());
    await expect(pending).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
});
test('an unchanged transcript publishes computed metadata and edited text while preserving unrelated message data', async () => {
    pending = edit(); await entered; resolve(result());
    expect(await pending).toBe(1);
    expect(readChat(file)).toEqual([{ chat_metadata: { variables: { keep: 1, computed: 1 } } }, { is_user: false, mes: 'Transformed', extra: { opaque: true } }]);
});
