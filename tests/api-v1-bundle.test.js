import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { serverDirectory } from '../dist/src/server-directory.js';

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
        expect(manifest.entry).toBe('dist/src/headless-companion.js');
        expect(manifest.fileCount).toBeGreaterThan(20);
        expect(manifest.nodeEngine).toBe('>=20');
    });

    test('contains the entry, headless runtime and defaults', () => {
        expect(fs.existsSync(path.join(serverDirectory, 'dist/dist'))).toBe(false);
        for (const file of [
            'dist/src/headless-companion.js',
            'dist/src/endpoints/api-v1.js',
            'dist/src/headless/runtime.js',
            'dist/src/headless/prompt-worker.js',
            'dist/src/headless/text-core.js',
            'dist/src/headless/regex-runtime.js',
            'dist/src/headless/regex-management.js',
            'dist/src/headless/prompt-core.js',
            'dist/src/headless/prompt-runtime/compat/engine.js',
            'dist/src/headless/prompt-runtime/compat/manager.js',
            'dist/src/headless/prompt-runtime/compat/reasoning-defaults.js',
            'dist/src/headless/prompt-runtime/compat/manifest.json',
            'dist/src/headless/world-info-runtime/compat/engine.js',
            'dist/src/headless/world-info-runtime/compat/authors-note.js',
            'dist/src/headless/world-info-runtime/compat/manifest.json',
            'dist/src/headless/macro-runtime/compat/manifest.json',
            'dist/src/headless/macro-runtime/compat/engine/MacroParser.js',
            'dist/src/headless/macro-runtime/compat/definitions/variable-macros.js',
            'dist/src/headless/plugin-worker.js',
            'dist/src/headless/plugin-context.js',
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

    test('ships extension assets without the browser SPA, user data or dev artifacts', () => {
        expect(fs.existsSync(path.join(out, 'compat-source/upstream/scripts/extensions/regex/manifest.json'))).toBe(true);
        expect(fs.existsSync(path.join(out, 'compat-source/upstream/index.html'))).toBe(false);
        expect(fs.existsSync(path.join(out, 'node_modules'))).toBe(false);
        expect(fs.existsSync(path.join(out, 'data'))).toBe(false);
        expect(fs.existsSync(path.join(out, 'config.yaml'))).toBe(false);
    });

    test('resolves the full relative import graph', () => {
        for (const file of ['dist/src/express-common.js', 'dist/src/users.js', 'dist/src/util.js', 'dist/src/endpoints/secrets.js']) {
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
