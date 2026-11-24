import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getUserKey } from '../dist/src/headless/contract.js';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
    abandonClientGeneration, acknowledgeGeneration, appendToken, assertCharacterIdle, assertChatIdle, beginGeneration, cancel, clearGenerations,
    complete, createGeneration, endGeneration, fail, getGeneration, getGenerationByClient,
    listGenerations, markProviderDispatched, persistGeneration, prepareGroupProgress, recordGroupCommit, restoreGenerations, setUsage, snapshot,
} from '../dist/src/headless/generation-store.js';

let root, directories;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-durable-journal-')); directories = { root }; });
afterEach(() => { clearGenerations(); jest.useRealTimers(); jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const options = (extra = {}) => ({ handle: 'owner', clientRequestId: 'caller-key', characterId: 'Aria', chatId: 'Chat', type: 'normal', directories, requestIdentity: { input: 'private prompt not copied into admission metadata', overrides: { model: 'one', temperature: 0.5 } }, ...extra });

describe('durable caller identity and failure handling', () => {
    test('group batch IDs avoid collisions with stored transcript IDs', () => {
        const record = createGeneration(options({ targetKind: 'group' })).record;
        beginGeneration(record);
        jest.spyOn(Date, 'now').mockReturnValue(123456);
        prepareGroupProgress(record, ['Aria.png'], [123456, 123457]);
        expect(record.groupProgress.generationId).toBe(123458);
    });
    test('persists the group speaker order and committed replies across interruption', () => {
        const record = createGeneration(options({ targetKind: 'group' })).record;
        beginGeneration(record);
        prepareGroupProgress(record, ['Aria.png', 'Bob.png']);
        expect(() => recordGroupCommit(record, 'Bob.png', 3)).toThrow('out of order');
        markProviderDispatched(record);
        recordGroupCommit(record, 'Aria.png', 2);
        clearGenerations();
        const restored = getGeneration(record.requestId, 'owner', directories);
        expect(snapshot(restored)).toMatchObject({ status: 'unknown', committed: true, groupProgress: { members: ['Aria.png', 'Bob.png'], completed: [{ member: 'Aria.png', messageIndex: 2 }] } });
        expect(() => prepareGroupProgress(restored, ['Bob.png'])).toThrow();
    });
    test('retains separate group provider usage and missing usage across restoration', () => {
        const record = createGeneration(options({ targetKind: 'group' })).record;
        beginGeneration(record);
        markProviderDispatched(record);
        setUsage(record, { prompt_tokens: 10 });
        setUsage(record, { completion_tokens: 4 });
        markProviderDispatched(record);
        markProviderDispatched(record);
        setUsage(record, { total_tokens: 8 });
        persistGeneration(directories, record);
        clearGenerations();
        const restored = getGeneration(record.requestId, 'owner', directories);
        expect(restored.providerCallCount).toBe(3);
        expect(snapshot(restored).usageByCall).toEqual([{ promptTokens: 10, completionTokens: 4 }, null, { totalTokens: 8 }]);
        expect(restored.status).toBe('unknown');
    });
    test('retains character usage behavior and accepts older group records', () => {
        const character = createGeneration(options()).record;
        setUsage(character, { prompt_tokens: 2 });
        setUsage(character, { completion_tokens: 3 });
        expect(snapshot(character).usage).toEqual({ promptTokens: 2, completionTokens: 3 });
        expect(snapshot(character).usageByCall).toBeUndefined();
        const group = createGeneration(options({ clientRequestId: 'group', targetKind: 'group' })).record;
        delete group.usageByCall;
        delete group.providerCallCount;
        markProviderDispatched(group);
        setUsage(group, { total_tokens: 5 });
        expect(snapshot(group).usageByCall).toEqual([{ totalTokens: 5 }]);
    });
    test('keeps group and character admissions distinct across restart', () => {
        const character = createGeneration(options()).record;
        const group = createGeneration(options({ clientRequestId: 'group-key', targetKind: 'group' })).record;
        expect(listGenerations('owner', directories, { characterId: 'Aria', chatId: 'Chat' }).generations.map(item => item.requestId)).toEqual([character.requestId]);
        expect(listGenerations('owner', directories, { characterId: 'Aria', chatId: 'Chat', targetKind: 'group' }).generations.map(item => item.requestId)).toEqual([group.requestId]);
        clearGenerations();
        expect(getGeneration(group.requestId, 'owner', directories).targetKind).toBe('group');
        expect(snapshot(getGeneration(group.requestId, 'owner', directories)).targetKind).toBe('group');
        expect(snapshot(getGeneration(character.requestId, 'owner', directories)).targetKind).toBe('character');
        expect(() => createGeneration(options({ clientRequestId: 'group-key' }))).toThrow('different generation payload');
    });
    test('an unresolved group turn fences only its own target after restart', () => {
        const group = createGeneration(options({ clientRequestId: 'group-key', targetKind: 'group' })).record;
        clearGenerations();
        expect(() => assertChatIdle('owner', 'Aria', 'Chat', directories, 'group')).toThrow('unresolved generation');
        expect(() => assertCharacterIdle('owner', 'Aria', directories, 'group')).toThrow('unresolved generation');
        expect(() => assertChatIdle('owner', 'Aria', 'Chat', directories)).not.toThrow();
        expect(() => assertCharacterIdle('owner', 'Aria', directories)).not.toThrow();
        expect(snapshot(getGeneration(group.requestId, 'owner', directories)).status).toBe('unknown');
    });
    test('shared group chat files remain fenced across group identities and restart', () => {
        createGeneration(options({ clientRequestId: 'group-key', targetKind: 'group' }));
        expect(() => createGeneration(options({ clientRequestId: 'other-key', characterId: 'OtherGroup', targetKind: 'group' }))).toThrow('active generation');
        clearGenerations();
        expect(() => assertChatIdle('owner', 'OtherGroup', 'Chat', directories, 'group')).toThrow('unresolved generation');
        const shared = listGenerations('owner', directories, { characterId: 'OtherGroup', chatId: 'Chat', targetKind: 'group', unresolvedOnly: true });
        expect(shared.generations).toHaveLength(1);
        expect(shared.generations[0].characterId).toBe('Aria');
        expect(() => createGeneration(options({ clientRequestId: 'other-key', characterId: 'OtherGroup', targetKind: 'group' }))).toThrow('unresolved generation');
        expect(() => createGeneration(options({ clientRequestId: 'character-key', characterId: 'OtherGroup' }))).not.toThrow();
    });
    test('abandoning a group caller key survives restart and prevents delayed admission', () => {
        const abandoned = abandonClientGeneration('owner', directories, 'group-key', 'Aria', 'Chat', 'group');
        expect(abandoned.targetKind).toBe('group');
        clearGenerations();
        expect(() => createGeneration(options({ clientRequestId: 'group-key', targetKind: 'group' }))).toThrow('different generation payload');
        expect(() => abandonClientGeneration('owner', directories, 'group-key', 'Aria', 'Chat')).toThrow('different chat');
    });
    test('synchronizes a permanent index before publishing accepted work without storing prompt input', () => {
        const { record } = createGeneration(options());
        const files = fs.readdirSync(path.join(root, 'api-v1-generations'));
        expect(files.filter(name => name.startsWith('client-'))).toHaveLength(1);
        expect(files).toContain(`${record.requestId}.json`);
        for (const file of files) expect(fs.readFileSync(path.join(root, 'api-v1-generations', file), 'utf8')).not.toContain('private prompt');
    });
    test('the same caller key never dispatches again after cache expiry or process restoration', () => {
        jest.useFakeTimers();
        const { record } = createGeneration(options());
        complete(record, { messageIndex: 1 });
        jest.advanceTimersByTime(300001);
        const expired = createGeneration(options());
        expect(expired.existing).toBe(true);
        expect(expired.record.requestId).toBe(record.requestId);
        clearGenerations();
        const restored = createGeneration(options());
        expect(restored.existing).toBe(true);
        expect(restored.record.requestId).toBe(record.requestId);
        expect(restored.record.status).toBe('done');
    });
    test('compares normalized request payloads, not just chat/type identifiers', () => {
        const { record } = createGeneration(options());
        complete(record, { messageIndex: 1 });
        expect(createGeneration(options({ requestIdentity: { overrides: { temperature: 0.5, model: 'one' }, input: 'private prompt not copied into admission metadata' } })).existing).toBe(true);
        expect(() => createGeneration(options({ requestIdentity: { input: 'different' } }))).toThrow('different generation payload');
    });
    test('legacy cancellations remain uncertain and cannot silently authorize a new model request', () => {
        const requestId = crypto.randomUUID();
        const dir = path.join(root, 'api-v1-generations'); fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, requestId + '.json'), JSON.stringify({ requestId, userKey: getUserKey('owner'), clientRequestId: 'legacy', characterId: 'Aria', chatId: 'Chat', type: 'normal', status: 'cancelled', cancelOutcome: 'requested', text: 'Partial', createdAt: 1, seq: 3 }));
        const record = getGeneration(requestId, 'owner', directories);
        expect(record.status).toBe('cancelled');
        expect(record.cancelOutcome).toBe('unknown');
        expect(record.acknowledged).toBe(false);
        expect(() => createGeneration(options())).toThrow('unresolved generation');
        expect(() => createGeneration(options({ clientRequestId: 'legacy' }))).toThrow('legacy request identity');
    });
    test('legacy quiet snapshots repair commit metadata and recover full text from the retained result', () => {
        const requestId = crypto.randomUUID();
        const dir = path.join(root, 'api-v1-generations'); fs.mkdirSync(dir);
        const text = 'x'.repeat(70000);
        fs.writeFileSync(path.join(dir, requestId + '.json'), JSON.stringify({ requestId, userKey: getUserKey('owner'), clientRequestId: 'legacy', characterId: 'Aria', chatId: 'Chat', type: 'quiet', status: 'done', committed: true, text: text.slice(0, 65536), snapshot: { text, messageIndex: null }, createdAt: 1, seq: 3 }));
        const record = getGeneration(requestId, 'owner', directories);
        expect(record.committed).toBe(false);
        expect(record.text).toBe(text);
        expect(record.acknowledged).toBe(true);
        clearGenerations();
        expect(getGeneration(requestId, 'owner', directories).text).toBe(text);
    });
    test('refuses admission if its journal path cannot be written', () => {
        fs.writeFileSync(path.join(root, 'api-v1-generations'), 'not a directory');
        expect(() => createGeneration(options())).toThrow('storage');
    });
    test('an index synchronization failure remains recoverable without creating a second identity', () => {
        const original = fs.fsyncSync.bind(fs);
        let syncs = 0;
        jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (++syncs === 5) throw new Error('injected index sync failure'); return original(fd); });
        expect(() => createGeneration(options())).toThrow('storage');
        jest.restoreAllMocks();
        const priorFiles = fs.readdirSync(path.join(root, 'api-v1-generations')).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
        expect(priorFiles).toHaveLength(1);
        const recovered = createGeneration(options());
        expect(recovered.existing).toBe(true);
        expect(recovered.record.requestId + '.json').toBe(priorFiles[0]);
        expect(recovered.record.status).toBe('unknown');
        expect(fs.readdirSync(path.join(root, 'api-v1-generations')).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))).toHaveLength(1);
    });
    test('corrupt indexes fail closed rather than turning into a new billable request', () => {
        const { record } = createGeneration(options());
        complete(record, { messageIndex: 1 });
        const index = fs.readdirSync(path.join(root, 'api-v1-generations')).find(name => name.startsWith('client-'));
        fs.writeFileSync(path.join(root, 'api-v1-generations', index), 'broken');
        clearGenerations();
        expect(() => createGeneration(options())).toThrow('storage');
    });
    test('missing result files behind a durable index are not reported as unadmitted', () => {
        const { record } = createGeneration(options());
        complete(record, { messageIndex: 1 });
        fs.unlinkSync(path.join(root, 'api-v1-generations', `${record.requestId}.json`));
        clearGenerations();
        expect(() => getGenerationByClient('caller-key', 'owner', directories)).toThrow('storage');
    });
});

describe('scoped discovery, cancellation drain and unknown acknowledgements', () => {
    test('discovers old results outside the recent cache and pages only the requested chat/user', () => {
        jest.spyOn(crypto, 'randomUUID').mockReturnValueOnce('00000000-0000-4000-8000-000000000001');
        const oldest = createGeneration(options()).record;
        oldest.createdAt = 1;
        complete(oldest, { messageIndex: 1 });
        for (let i = 0; i < 205; i++) {
            const record = createGeneration(options({ clientRequestId: `key-${i}` })).record;
            complete(record, { messageIndex: i + 2 });
        }
        clearGenerations();
        restoreGenerations(directories);
        expect(getGenerationByClient('caller-key', 'owner', directories).requestId).toBe(oldest.requestId);
        expect(getGeneration(oldest.requestId, 'owner', directories).status).toBe('done');
        expect(() => getGeneration(oldest.requestId, 'someone-else', directories)).toThrow('not found');
        const page = listGenerations('owner', directories, { characterId: 'Aria', chatId: 'Chat', limit: 10 });
        expect(page.generations).toHaveLength(10);
        expect(page.hasMore).toBe(true);
        const next = listGenerations('owner', directories, { characterId: 'Aria', chatId: 'Chat', limit: 10, before: page.nextBefore });
        expect(new Set([...page.generations, ...next.generations].map(item => item.requestId)).size).toBe(20);
        expect(listGenerations('owner', directories, { characterId: 'Aria', chatId: 'Other' }).generations).toEqual([]);
    }, 30000);
    test('cancelled workers stay nonterminal until drained and block new admission', () => {
        const { record } = createGeneration(options());
        expect(beginGeneration(record)).toBe(true);
        markProviderDispatched(record);
        cancel(record);
        expect(record.status).toBe('cancelling');
        expect(snapshot(record).drained).toBe(false);
        expect(() => acknowledgeGeneration(record, record.seq)).toThrow('Wait');
        expect(() => createGeneration(options({ clientRequestId: 'next' }))).toThrow('active generation');
        endGeneration(record);
        expect(record.status).toBe('cancelled');
        expect(record.cancelOutcome).toBe('unknown');
        expect(() => createGeneration(options({ clientRequestId: 'next' }))).toThrow('unresolved generation');
        expect(() => acknowledgeGeneration(record, record.seq - 1)).toThrow('changed');
        acknowledgeGeneration(record, record.seq);
        expect(createGeneration(options({ clientRequestId: 'next' })).existing).toBe(false);
    });
    test('a solitary partial chunk is checkpointed even when no later token arrives', () => {
        jest.useFakeTimers();
        const { record } = createGeneration(options());
        beginGeneration(record); markProviderDispatched(record);
        appendToken(record, 'Checkpointed partial');
        jest.advanceTimersByTime(501);
        clearGenerations();
        const restored = getGeneration(record.requestId, 'owner', directories);
        expect(restored.status).toBe('unknown');
        expect(restored.text).toBe('Checkpointed partial');
    });
    test('restart turns interrupted work into a durable unknown without allowing a hidden new turn', () => {
        const { record } = createGeneration(options());
        beginGeneration(record); markProviderDispatched(record);
        clearGenerations();
        const restored = getGeneration(record.requestId, 'owner', directories);
        expect(restored.status).toBe('unknown');
        expect(restored.drained).toBe(true);
        expect(() => createGeneration(options({ clientRequestId: 'next' }))).toThrow('unresolved generation');
        acknowledgeGeneration(restored, restored.seq);
        clearGenerations();
        expect(getGeneration(record.requestId, 'owner', directories).acknowledged).toBe(true);
    });
    test('abandoning unconfirmed acceptance reserves the key against a delayed POST', () => {
        const abandoned = abandonClientGeneration('owner', directories, 'caller-key', 'Aria', 'Chat');
        expect(abandoned.status).toBe('cancelled');
        expect(abandoned.providerDispatched).toBe(false);
        expect(() => createGeneration(options())).toThrow('different generation payload');
        clearGenerations();
        expect(() => createGeneration(options())).toThrow('different generation payload');
    });
    test('abandoning an already admitted key cancels only that original worker', () => {
        const { record } = createGeneration(options());
        beginGeneration(record);
        expect(abandonClientGeneration('owner', directories, 'caller-key', 'Aria', 'Chat').status).toBe('cancelling');
        expect(() => abandonClientGeneration('owner', directories, 'caller-key', 'Other', 'Chat')).toThrow('different chat');
        endGeneration(record);
        expect(record.status).toBe('cancelled');
        expect(record.providerDispatched).toBe(false);
    });
    test('completion storage failure is visible and cannot be mistaken for a durable done result', () => {
        const { record } = createGeneration(options());
        beginGeneration(record); markProviderDispatched(record);
        fs.renameSync(path.join(root, 'api-v1-generations'), path.join(root, 'saved-journals'));
        fs.writeFileSync(path.join(root, 'api-v1-generations'), 'unwritable');
        complete(record, { messageIndex: 1 });
        expect(record.status).toBe('unknown');
        expect(record.committed).toBe(true);
        expect(record.error.code).toBe('storage');
        endGeneration(record);
        expect(record.drained).toBe(true);
    });
});
