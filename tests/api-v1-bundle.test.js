import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { serverDirectory } from '../src/server-directory.js';

const SCRIPT = path.join(serverDirectory, 'scripts', 'build-companion-bundle.mjs');
let out;
let manifest;

beforeAll(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'st-bundle-test-'));
    execFileSync(process.execPath, [SCRIPT, '--out', out], { cwd: serverDirectory, encoding: 'utf8' });
    manifest = JSON.parse(fs.readFileSync(path.join(out, 'companion-bundle.json'), 'utf8'));
});

afterAll(() => {
    fs.rmSync(out, { recursive: true, force: true });
});

describe('companion bundle builder', () => {
    test('writes a self-describing manifest', () => {
        expect(manifest.schema).toBe(1);
        expect(manifest.service).toBe('messenger-sillytavern');
        expect(manifest.entry).toBe('src/headless-companion.js');
        expect(manifest.fileCount).toBeGreaterThan(20);
        expect(manifest.nodeEngine).toBe('>=20');
    });

    test('contains the entry, headless runtime and defaults', () => {
        for (const file of [
            'src/headless-companion.js',
            'src/endpoints/api-v1.js',
            'src/headless/runtime.js',
            'src/headless/prompt-worker.js',
            'src/headless/prompt-core.js',
            'src/headless/world-info-runtime/generated/engine.js',
            'src/headless/world-info-runtime/generated/authors-note.js',
            'src/headless/world-info-runtime/generated/manifest.json',
            'src/headless/macro-runtime/generated/manifest.json',
            'src/headless/macro-runtime/generated/engine/MacroParser.js',
            'src/headless/macro-runtime/generated/definitions/variable-macros.js',
            'src/headless/plugin-worker.js',
            'src/headless/plugin-context.js',
            'default/content/settings.json',
            'default/content/presets/openai/Default.json',
            'default/content/presets/instruct/Alpaca.json',
            'default/config.yaml',
            'package.json',
            'pnpm-lock.yaml',
        ]) {
            expect(fs.existsSync(path.join(out, file))).toBe(true);
        }
    });

    test('does not ship the browser SPA, user data or dev artifacts', () => {
        expect(fs.existsSync(path.join(out, 'public'))).toBe(false);
        expect(fs.existsSync(path.join(out, 'node_modules'))).toBe(false);
        expect(fs.existsSync(path.join(out, 'data'))).toBe(false);
        expect(fs.existsSync(path.join(out, 'config.yaml'))).toBe(false);
    });

    test('resolves the full relative import graph', () => {
        for (const file of ['src/express-common.js', 'src/users.js', 'src/util.js', 'src/endpoints/secrets.js']) {
            expect(fs.existsSync(path.join(out, file))).toBe(true);
        }
        expect(manifest.externalPackages).toContain('express');
    });

    test('regenerating is deterministic and idempotent', () => {
        const before = manifest.fileCount;
        execFileSync(process.execPath, [SCRIPT, '--out', out], { cwd: serverDirectory, encoding: 'utf8' });
        const again = JSON.parse(fs.readFileSync(path.join(out, 'companion-bundle.json'), 'utf8'));
        expect(again.fileCount).toBe(before);
        expect(again.stVersion).toBe(manifest.stVersion);
    });
});
