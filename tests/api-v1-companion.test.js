import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import WebSocket from 'ws';
import { ExtensionRpcClient } from '../scripts/compat-min-client.mjs';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { serverDirectory } from '../dist/src/server-directory.js';

const COMPANION_SCRIPT = path.join(serverDirectory, 'dist', 'src', 'headless-companion.js');
let dataRoot;
let child;
let baseUrl;
let token;

/**
 * Waits for the single companion_ready handshake line on stdout.
 * @returns {Promise<{port: number, token: string}>} Handshake
 */
function waitForReady() {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Companion did not become ready in time.')), 15_000);
        let buffer = '';
        child.stdout.on('data', chunk => {
            buffer += String(chunk);
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const message = JSON.parse(line);
                    if (message.type === 'companion_ready') {
                        clearTimeout(timer);
                        resolve(message);
                    }
                } catch { /* ignore non-handshake log lines */ }
            }
        });
        child.once('exit', code => {
            clearTimeout(timer);
            reject(new Error(`Companion exited early with ${code}.`));
        });
    });
}

beforeAll(async () => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-companion-test-'));
    token = 'a'.repeat(64);
    child = spawn(process.execPath, [COMPANION_SCRIPT, '--dataRoot', dataRoot, '--port', '0', '--token', token], {
        cwd: serverDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', () => { /* keep the pipe drained */ });
    const ready = await waitForReady();
    if (ready.token !== token || !(ready.port > 0)) {
        throw new Error('Companion handshake was invalid.');
    }
    baseUrl = `http://127.0.0.1:${ready.port}`;
});

afterAll(async () => {
    if (child && !child.killed) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await Promise.race([
            exited,
            new Promise(resolve => { const t = setTimeout(resolve, 3000); t.unref?.(); }),
        ]);
    }
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

/**
 * Makes an authenticated or unauthenticated API request.
 * @param {string} endpoint API path
 * @param {object} options Fetch options
 * @param {boolean} auth Attach the bearer capability
 * @returns {Promise<{status: number, body: any}>} Response
 */
async function request(endpoint, options = {}, auth = true) {
    const headers = { ...(options.headers ?? {}) };
    if (auth) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(baseUrl + endpoint, { ...options, headers });
    return { status: response.status, body: await response.json().catch(() => null) };
}

describe('headless companion entry', () => {
    test('minimum native-side client completes a live loopback request', () => {
        const output = execFileSync(process.execPath, [path.join(serverDirectory, 'scripts/compat-min-client.mjs')], {
            cwd: serverDirectory,
            encoding: 'utf8',
            env: { ...process.env, ST_COMPANION_PORT: new URL(baseUrl).port, ST_COMPANION_CAPABILITY: token },
        });
        expect(JSON.parse(output)).toMatchObject({ connected: true });
    });

    test('WebSocket RPC requires capability and processes sequenced calls', async () => {
        const port = new URL(baseUrl).port;
        const denied = new WebSocket(`ws://127.0.0.1:${port}/compat/ws`);
        await new Promise(resolve => denied.once('unexpected-response', (_request, response) => {
            expect(response.statusCode).toBe(401);
            response.resume();
            resolve();
        }));
        const client = new ExtensionRpcClient({ port: Number(port), capability: token });
        const replies = await Promise.all([client.call('GET', '/characters'), client.call('GET', '/characters')]);
        expect(replies.every(reply => reply.type === 'result' && reply.ok && reply.status === 200)).toBe(true);
        client.close();
    });

    test('WebSocket RPC refuses credential endpoints and does not execute them', async () => {
        const client = new ExtensionRpcClient({ port: Number(new URL(baseUrl).port), capability: token });
        expect(await client.call('GET', '/providers/credentials')).toMatchObject({ type: 'result', ok: false, error: { code: 'unsupported' } });
        client.close();
    });

    test('health requires the scoped capability', async () => {
        const denied = await request('/api/v1/companion/health', {}, false);
        expect(denied.status).toBe(401);
        expect(denied.body.error.code).toBe('unauthorized');
        const ok = await request('/api/v1/companion/health');
        expect(ok.status).toBe(200);
        expect(ok.body.service).toBe('messenger-sillytavern');
    });

    test('credentialed CORS permits any origin while actual requests still require the capability', async () => {
        const preflight = await fetch(baseUrl + '/api/v1/characters', {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://client.example',
                'Access-Control-Request-Method': 'GET',
                'Access-Control-Request-Headers': 'authorization',
            },
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-origin')).toBe('https://client.example');
        expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
        expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
        const denied = await fetch(baseUrl + '/api/v1/characters', { headers: { Origin: 'https://client.example' } });
        expect(denied.status).toBe(401);
        expect(denied.headers.get('access-control-allow-origin')).toBe('https://client.example');
    });

    test('capabilities advertise bearer auth in companion mode', async () => {
        const { status, body } = await request('/api/v1/capabilities');
        expect(status).toBe(200);
        expect(body.auth.bearerToken).toBe(true);
        expect(body.auth.cookieSession).toBe(false);
        expect(body.generation.restoreAfterRestart).toBe(true);
        expect(body.resources.chatPaging).toBe(true);
        expect(body.resources.chatSnapshot).toBe(true);
        expect(body.resources.groupChatSnapshot).toBe(true);
        expect(body.resources.providerStatus).toBe(true);
        expect(body.resources.clientExtensionPrompts).toBe(true);
    });

    test('every non-health route is gated by the capability', async () => {
        for (const endpoint of ['/api/v1/characters', '/api/v1/settings', '/api/v1/extensions', '/api/v1/provider-status', '/api/v1/provider-status/check', '/api/v1/chats/chat/snapshot?characterId=ada', '/api/v1/groups/team/chats/shared/snapshot', '/']) {
            const denied = await request(endpoint, {}, false);
            expect(denied.status).toBe(401);
        }
        expect((await request('/api/v1/provider-status/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, false)).status).toBe(401);
    });

    test('the browser SPA and private routes are not exposed', async () => {
        for (const endpoint of ['/', '/index.html', '/login', '/style.css', '/scripts/extensions/regex/manifest.json']) {
            const { status, body } = await request(endpoint);
            expect(status).toBe(404);
            expect(body.error.code).toBe('not_found');
        }
    });

    test('extension compatibility diagnostics require the capability', async () => {
        const denied = await request('/compat/extensions', {}, false);
        expect(denied.status).toBe(401);
        const allowed = await request('/compat/extensions');
        expect(allowed.status).toBe(200);
        expect(Array.isArray(allowed.body.extensions)).toBe(true);
        const bundled = allowed.body.extensions.filter(extension => extension.type === 'system');
        expect(bundled).toHaveLength(14);
        expect(bundled.every(extension => Array.isArray(extension.diagnostics) && Array.isArray(extension.requiredCapabilities))).toBe(true);
    });

    test('runs a declared virtual DOM extension and returns a host fragment', async () => {
        const extensionRoot = path.join(dataRoot, 'default-user', 'extensions', 'dom-sample');
        fs.mkdirSync(extensionRoot, { recursive: true });
        fs.writeFileSync(path.join(extensionRoot, 'manifest.json'), JSON.stringify({ runtime: 'virtual-dom', entry: 'index.mjs' }));
        fs.writeFileSync(path.join(extensionRoot, 'index.mjs'), 'export function init({ $, document }) { $(document.body).append("<button>Native host</button>"); }');
        const response = await request('/compat/extensions/dom-sample/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        expect(response.status).toBe(200);
        expect(response.body.output.text).toBe('Native host');
        expect(response.body.output.html).toContain('<button>Native host</button>');
    });

    test('settings patch works over the companion transport', async () => {
        const created = await request('/api/v1/settings', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'Companion User' }),
        });
        expect(created.status).toBe(200);
        const settings = await request('/api/v1/settings');
        expect(settings.body.raw.username).toBe('Companion User');
    });

    test('bound to loopback only', () => {
        expect(baseUrl).toContain('127.0.0.1');
    });
});
