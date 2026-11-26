import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

function clientModule(file) {
    const source = fs.readFileSync(new URL('../client/lib/' + file, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    const exports = {};
    new Function('exports', outputText)(exports);
    return exports;
}
const workspace = clientModule('workspace.ts');

class MemoryStorage {
    values = new Map();
    get length() { return this.values.size; }
    key(index) { return [...this.values.keys()][index] ?? null; }
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(key, value); }
    removeItem(key) { this.values.delete(key); }
}

describe('V1-only client transport', () => {
    let transport;
    beforeEach(() => {
        transport = clientModule('api.ts');
        globalThis.window = {};
        globalThis.localStorage = new MemoryStorage();
        globalThis.fetch = jest.fn(async () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }));
    });

    test.each(['https://example.test/api', 'https://user:password@example.test', 'https://example.test?token=x', 'ftp://example.test', 'https://example.test/#secret'])('rejects unsafe server origins: %s', value => {
        expect(() => transport.connectionBase(value)).toThrow();
    });
    test.each(['//example.test/steal', '/../../api/secrets', '/%2e%2e/secrets', 'https://example.test', '/\\example.test'])('rejects routes escaping the V1 boundary: %s', value => {
        expect(() => transport.apiUrl('http://127.0.0.1:8000', value)).toThrow();
    });
    test('keeps bearer credentials on the authenticated origin even when another tab changes storage', async () => {
        localStorage.setItem('st-v1-base-url', 'http://127.0.0.1:8000');
        transport.setSessionToken('private-capability');
        localStorage.setItem('st-v1-base-url', 'https://elsewhere.test');
        await transport.api('/characters');
        expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:8000/api/v1/characters');
        expect(fetch.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer private-capability');
        expect(fetch.mock.calls[0][1].redirect).toBe('error');
        expect([...localStorage.values.values()].join('')).not.toContain('private-capability');
    });
    test('invalidates old editor clients on reconnect before another request is sent', async () => {
        localStorage.setItem('st-v1-base-url', 'http://127.0.0.1:8000'); transport.setSessionToken('first');
        const oldEditor = transport.createApiClient(); transport.setSessionToken('second');
        await expect(oldEditor('/world-info/book', { method: 'PUT', body: '{}' })).rejects.toThrow('connection changed');
        expect(fetch).not.toHaveBeenCalled();
    });
    test('does not send a companion capability to a remote host', () => {
        localStorage.setItem('st-v1-base-url', 'https://remote.test');
        expect(() => transport.setSessionToken('capability')).toThrow('loopback');
        expect(fetch).not.toHaveBeenCalled();
    });
    test('retains standard error details and never retries failed mutations', async () => {
        localStorage.setItem('st-v1-base-url', 'http://127.0.0.1:8000'); transport.setSessionToken('capability');
        fetch.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'conflict', message: 'Reload first.', requestId: 'request-1', details: { field: 'revision' } } }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
        await expect(transport.api('/prompt-manager', { method: 'PUT', body: '{}' })).rejects.toMatchObject({ status: 409, code: 'conflict', requestId: 'request-1', details: { field: 'revision' } });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    test('supports a bounded management timeout without forwarding private options to fetch', async () => {
        localStorage.setItem('st-v1-base-url', 'http://127.0.0.1:8000'); transport.setSessionToken('capability');
        const timeout = jest.spyOn(AbortSignal, 'timeout');
        try {
            await transport.createApiClient()('/package-management/bulk', { method: 'POST', body: '{}', timeoutMs: 120_000 });
            expect(timeout).toHaveBeenLastCalledWith(120_000);
            expect(fetch.mock.calls[0][1]).not.toHaveProperty('timeoutMs');
            await transport.api('/characters');
            expect(timeout).toHaveBeenLastCalledWith(30_000);
            await expect(transport.api('/characters', { timeoutMs: 120_001 })).rejects.toThrow('timeout');
            await expect(transport.api('/characters', { timeoutMs: NaN })).rejects.toThrow('timeout');
            expect(fetch).toHaveBeenCalledTimes(2);
        } finally { timeout.mockRestore(); }
    });
    test('rejects a truncated success response instead of clearing an editor with an empty object', async () => {
        localStorage.setItem('st-v1-base-url', 'http://127.0.0.1:8000'); transport.setSessionToken('capability');
        fetch.mockResolvedValue(new Response('{"revision":', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        await expect(transport.api('/prompt-manager', { method: 'PUT', body: '{}' })).rejects.toMatchObject({ code: 'invalid_response' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe('opaque fields, revisions and recovery identity', () => {
    test.each([undefined, 'chara_card_v2', 'chara_card_v3'])('edits card data without changing schema or opaque fields: %s', spec => {
        const card = spec ? { spec, spec_version: '3.0', data: { name: 'Ada', future: { retain: true } }, outer: ['opaque'] } : { name: 'Ada', future: { retain: true } };
        const edited = workspace.cardField(card, 'description', 'New description');
        expect(edited).toEqual(spec ? { ...card, data: { ...card.data, description: 'New description' } } : { ...card, description: 'New description' });
        expect(card.description ?? card.data?.description).toBeUndefined();
    });
    test('scoped saves use exactly the inspected revision and reject envelope edits', () => {
        const document = { revision: 'inspected', variables: { value: 1 }, experimental: true };
        expect(workspace.revisionBody(document, { variables: { value: 2 }, experimental: false }, ['variables', 'experimental'])).toEqual({ expectedRevision: 'inspected', variables: { value: 2 }, experimental: false });
        expect(() => workspace.revisionBody(document, { revision: 'forged', variables: {} }, ['variables'])).toThrow();
        expect(() => workspace.revisionBody({}, { variables: {} }, ['variables'])).toThrow();
    });
    test('caller identities are scoped to origin, account and target; group chats retain the original group ID', () => {
        const storage = new MemoryStorage(), base = 'http://127.0.0.1:8000';
        const own = { clientRequestId: 'own', characterId: 'ada', chatId: 'chat', targetKind: 'character' };
        storage.setItem(workspace.pendingKey(base, 'alice', own), JSON.stringify(own));
        storage.setItem(workspace.pendingKey(base, 'bob', { clientRequestId: 'foreign-user' }), JSON.stringify({ ...own, clientRequestId: 'foreign-user' }));
        storage.setItem(workspace.pendingKey('http://127.0.0.1:9000', 'alice', { clientRequestId: 'foreign-server' }), JSON.stringify(own));
        const group = { clientRequestId: 'shared', characterId: 'original-group', chatId: 'chat', targetKind: 'group' };
        storage.setItem(workspace.pendingKey(base, 'alice', group), JSON.stringify(group));
        expect(workspace.listPending(storage, base, 'alice', { id: 'ada', kind: 'character' }, 'chat')).toEqual([own]);
        expect(workspace.listPending(storage, base, 'alice', { id: 'other-group', kind: 'group' }, 'chat')).toEqual([group]);
    });
    test('corrupt pending identities block dispatch instead of being discarded', () => {
        const storage = new MemoryStorage(), base = 'http://127.0.0.1:8000';
        storage.setItem(workspace.pendingKey(base, 'alice', { clientRequestId: 'broken' }), '{broken');
        expect(() => workspace.listPending(storage, base, 'alice', { id: 'ada', kind: 'character' }, 'chat')).toThrow('corrupt');
    });
    test('legacy unscoped identities require explicit original-server inspection before migration', () => {
        const storage = new MemoryStorage(); storage.setItem('st-v1-pending:st-client-old', '{"requestId":"old-request"}');
        expect(() => workspace.listPending(storage, 'http://127.0.0.1:8000', 'alice', { id: 'ada', kind: 'character' }, 'chat')).toThrow('original server');
    });
    test('recognizes the actual backend error terminal state', () => {
        for (const status of ['done', 'error', 'cancelled', 'unknown']) expect(workspace.terminal(status)).toBe(true);
        for (const status of ['accepted', 'running', 'cancelling', 'waiting_tools']) expect(workspace.terminal(status)).toBe(false);
    });
    test('requires explicit capabilities instead of interpreting partial compatibility flags', () => {
        expect(workspace.enabled({ resources: { groupChatRender: true }, features: { groupChats: false } }, 'resources', 'groupChatRender')).toBe(true);
        expect(workspace.enabled({ resources: {} }, 'resources', 'characters')).toBe(false);
    });
});

test('client source contains no legacy API or direct-provider fetch escape', () => {
    const root = path.resolve('client');
    function scan(directory) {
        return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) return ['node_modules', '.next', '.next-dev', '.next-build', '.next-browser-dev'].includes(entry.name) ? [] : scan(file);
            return /\.(?:ts|tsx)$/.test(file) ? [file] : [];
        });
    }
    const fetchFiles = [];
    for (const file of scan(root)) {
        const source = fs.readFileSync(file, 'utf8');
        expect(source.match(/['"`]\/api\/(?!v1(?:\/|['"`]))[^'"`]*['"`]/g) ?? []).toEqual([]);
        if (/\bfetch\s*\(/.test(source)) fetchFiles.push(path.relative(root, file));
    }
    expect(fetchFiles.sort()).toEqual(['app/page.tsx', 'lib/api.ts']);
});
