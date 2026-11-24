import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { acquireGenerationOwner } from '../dist/src/headless/generation-owner.js';

let root, child;
const moduleUrl = new URL('../dist/src/headless/generation-owner.js', import.meta.url).href;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-owner-lease-')); });
afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await stopped; }
    child = null;
    fs.rmSync(root, { recursive: true, force: true });
});
const source = wait => `import { acquireGenerationOwner } from ${JSON.stringify(moduleUrl)}; acquireGenerationOwner(${JSON.stringify(root)}); console.log('owned'); ${wait ? 'setInterval(() => {}, 1000);' : ''}`;

describe('companion process generation lease', () => {
    test('rejects another live owner and reclaims only after the OS reports the original process stopped', async () => {
        child = spawn(process.execPath, ['--input-type=module', '-e', source(true)], { stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`Owner exited ${code}`))); });
        const blocked = spawnSync(process.execPath, ['--input-type=module', '-e', source(false)], { encoding: 'utf8' });
        expect(blocked.status).not.toBe(0);
        expect(blocked.stderr).toContain('Another live process');
        const stopped = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL'); await stopped;
        const recovered = spawnSync(process.execPath, ['--input-type=module', '-e', source(false)], { encoding: 'utf8' });
        expect(recovered.status).toBe(0);
        expect(recovered.stdout).toContain('owned');
    });
    test('does not treat a recycled PID with another start identity as its old owner', () => {
        fs.writeFileSync(path.join(root, '.generation-owner.lock'), JSON.stringify({ pid: process.pid, nonce: 'old', start: 'not-this-process' }));
        expect(() => acquireGenerationOwner(root)).not.toThrow();
        const current = JSON.parse(fs.readFileSync(path.join(root, '.generation-owner.lock', 'owner.json'), 'utf8'));
        expect(current.nonce).not.toBe('old');
    });
    test('an interrupted reclaimer fails closed instead of racing a new owner', () => {
        fs.writeFileSync(path.join(root, '.generation-owner.lock'), JSON.stringify({ pid: process.pid, nonce: 'old', start: 'not-this-process' }));
        fs.writeFileSync(path.join(root, '.generation-owner.reclaim'), 'interrupted');
        expect(() => acquireGenerationOwner(root)).toThrow('requires inspection');
    });
    test('a current owner detects replacement of its canonical claim', () => {
        acquireGenerationOwner(root);
        fs.writeFileSync(path.join(root, '.generation-owner.lock', 'owner.json'), JSON.stringify({ pid: process.pid, nonce: 'changed' }));
        expect(() => acquireGenerationOwner(root)).toThrow('ownership changed');
    });
});
