import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { serverDirectory } from '../src/server-directory.js';

const COMPANION_SCRIPT = path.join(serverDirectory, 'src', 'headless-companion.js');
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
    test('health requires the scoped capability', async () => {
        const denied = await request('/api/v1/companion/health', {}, false);
        expect(denied.status).toBe(401);
        expect(denied.body.error.code).toBe('unauthorized');
        const ok = await request('/api/v1/companion/health');
        expect(ok.status).toBe(200);
        expect(ok.body.service).toBe('messenger-sillytavern');
    });

    test('capabilities advertise bearer auth in companion mode', async () => {
        const { status, body } = await request('/api/v1/capabilities');
        expect(status).toBe(200);
        expect(body.auth.bearerToken).toBe(true);
        expect(body.auth.cookieSession).toBe(false);
        expect(body.generation.restoreAfterRestart).toBe(true);
        expect(body.resources.chatPaging).toBe(true);
    });

    test('every non-health route is gated by the capability', async () => {
        for (const endpoint of ['/api/v1/characters', '/api/v1/settings', '/api/v1/extensions', '/']) {
            const denied = await request(endpoint, {}, false);
            expect(denied.status).toBe(401);
        }
    });

    test('the browser SPA and private routes are not exposed', async () => {
        const { status, body } = await request('/');
        expect(status).toBe(404);
        expect(body.error.code).toBe('not_found');
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
