import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from '@jest/globals';
import { buildPrompt } from '../dist/src/headless/prompt.js';
import { writeSettings, readSettings } from '../dist/src/headless/session.js';

const roots = [];
function fixture({ context = 4096, response = 100, prompts, order, oai = {}, power = {} } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-source-prompt-')); roots.push(root);
    const settings = { main_api: 'openai', power_user: power, oai_settings: { chat_completion_source: 'openai', openai_model: 'gpt-4', openai_max_context: context, openai_max_tokens: response, new_chat_prompt: '', prompts: prompts ?? [{ identifier: 'main', content: 'Main' }], prompt_order: [{ character_id: 100001, order: (order ?? ['main', 'charDescription', 'personaDescription', 'dialogueExamples', 'chatHistory', 'jailbreak']).map(value => typeof value === 'string' ? { identifier: value, enabled: true } : value) }], ...oai } };
    const session = { handle: 'source-prompt', directories: { root }, settings, extensionSettings: {}, userName: 'Reader' };
    return { session, character: { name: 'Aria', description: 'Character' }, chat: [{ chat_metadata: {} }], build(chat, options = {}) { return buildPrompt(session, this.character, chat, { type: 'normal', characterId: 'Aria', chatId: 'Chat', ...options }); } };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const rows = (count, content = i => `Line ${i}`) => Array.from({ length: count }, (_, index) => ({ name: index % 2 ? 'Aria' : 'Reader', is_user: index % 2 === 0, mes: content(index) }));
const history = result => result.messages.filter(message => ['user', 'assistant'].includes(message.role));
describe('request extension prompt packing', () => {
    test('request extension prompts enter source depth/role and relative assembly without persisting', async () => {
        const f = fixture();
        const injected = { deep: { value: 'At depth {{char}}', position: 1, depth: 0, scan: false, role: 1 }, before: { value: 'Before story', position: 2, depth: 0, scan: false, role: 0 }, hidden: { value: 'Do not pack', position: -1, depth: 0, scan: false, role: 0 } };
        const chat = [...f.chat, ...rows(2)];
        const built = await f.build(chat, { extensionPrompts: injected, preview: true });
        expect(built.messages).toContainEqual(expect.objectContaining({ role: 'user', content: expect.stringContaining('At depth Aria') }));
        expect(built.messages.some(row => row.content.includes('Before story'))).toBe(true);
        expect(built.messages.some(row => row.content.includes('Do not pack'))).toBe(false);
        expect((await f.build(chat)).messages.some(row => row.content.includes('At depth'))).toBe(false);
        expect(chat).toHaveLength(3);
    });
});
