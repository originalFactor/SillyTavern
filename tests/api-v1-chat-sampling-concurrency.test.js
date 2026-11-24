import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, jest, test } from '@jest/globals';

let file;
let release;
let entered;
let calls = 0;
const paused = new Promise(resolve => { entered = resolve; });
const resume = new Promise(resolve => { release = resolve; });

jest.unstable_mockModule('../dist/src/headless/group-management.js', () => ({
    resolveGroupChat: async () => {
        const chat = fs.readFileSync(file, 'utf8').split('\n').map(JSON.parse);
        calls++;
        if (calls === 2) {
            entered();
            await resume;
        }
        return { file, chat };
    },
    parseGroupChat: target => fs.readFileSync(target, 'utf8').split('\n').map(JSON.parse),
}));

const { readGroupSampling, saveGroupSampling } = await import('../dist/src/headless/chat-sampling.js');

test('a transcript edit during sampling resolution is preserved and causes a conflict', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sampling-race-'));
    file = path.join(root, 'chat.jsonl');
    const header = { chat_metadata: {} };
    const message = { name: 'Reader', is_user: true, mes: 'before' };
    fs.writeFileSync(file, [header, message].map(JSON.stringify).join('\n'));
    const session = { handle: 'race', directories: null };
    try {
        const initial = await readGroupSampling(session, 'group', 'chat');
        calls = 0;
        const save = saveGroupSampling(session, 'group', 'chat', { expectedRevision: initial.revision, overrides: { temperature: 0.5 } });
        await paused;
        const edited = { ...message, mes: 'after' };
        fs.writeFileSync(file, [header, edited].map(JSON.stringify).join('\n'));
        release();
        await expect(save).rejects.toMatchObject({ status: 409, code: 'conflict' });
        expect(fs.readFileSync(file, 'utf8').split('\n').map(JSON.parse)).toEqual([header, edited]);
    } finally {
        release();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
