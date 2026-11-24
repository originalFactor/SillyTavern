import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { serverDirectory } from '../dist/src/server-directory.js';

let root;
let child;
let url;
let token;
let shutdownMarker;

function waitForReady() {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Headless server did not start.')), 15_000);
        let output = '';
        child.stdout.on('data', chunk => {
            output += String(chunk);
            for (const line of output.split('\n')) {
                try {
                    const message = JSON.parse(line);
                    if (message.type === 'companion_ready') {
                        clearTimeout(timeout);
                        resolve(message);
                    }
                } catch { /* startup logs are not handshake messages */ }
            }
            output = output.slice(-4096);
        });
        child.once('exit', code => reject(new Error(`Headless server exited before startup (${code}).`)));
    });
}

beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-server-plugin-'));
    shutdownMarker = path.join(root, 'plugin-exited');
    fs.writeFileSync(path.join(root, 'config.yaml'), [
        `dataRoot: ${JSON.stringify(root)}`,
        'listen: false',
        'enableServerPlugins: true',
        'enableServerPluginsAutoUpdate: false',
        'api:',
        '  v1:',
        '    enabled: true',
        '',
    ].join('\n'));
    const pluginDir = path.join(root, 'plugins', 'sample');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'index.mjs'), [
        'import fs from "node:fs";',
        'export const info = { id: "sample", name: "Sample", description: "Companion lifecycle test" };',
        'export function init(router) { router.get("/health", (_req, res) => res.json({ plugin: "ready" })); }',
        `export function exit() { fs.writeFileSync(${JSON.stringify(shutdownMarker)}, 'closed'); }`,
        '',
    ].join('\n'));
    child = spawn(process.execPath, [path.join(serverDirectory, 'dist/src/headless-server.js')], {
        cwd: serverDirectory,
        env: { ...process.env, SILLYTAVERN_DATA_ROOT: root, SILLYTAVERN_PORT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', () => {});
    const ready = await waitForReady();
    token = ready.token;
    url = `http://127.0.0.1:${ready.port}`;
});

afterAll(async () => {
    if (child && !child.killed) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    child?.stdout.destroy();
    child?.stderr.destroy();
    fs.rmSync(root, { recursive: true, force: true });
});

describe('companion Express plugin lifecycle', () => {
    test('mounts plugin routes behind bearer auth', async () => {
        const denied = await fetch(`${url}/api/plugins/sample/health`);
        expect(denied.status).toBe(401);
        const response = await fetch(`${url}/api/plugins/sample/health`, { headers: { Authorization: `Bearer ${token}` } });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ plugin: 'ready' });
    });

    test('runs plugin shutdown hooks', async () => {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
        expect(fs.readFileSync(shutdownMarker, 'utf8')).toBe('closed');
    });
});
