import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { zipSync, strToU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { router } from '../src/endpoints/api-v1.js';
import { DEFAULT_USER, USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';
import { serverDirectory } from '../src/server-directory.js';

let root, directories, server, base;
const icon = fs.readFileSync(path.join(serverDirectory, 'default/content/default_Seraphina.png'));
const sprite = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function card(assets = []) {
    return {
        spec: 'chara_card_v3', spec_version: '3.0',
        data: { name: 'CHARX 角色', description: 'A bounded archive.', first_mes: 'Hello {{user}}.', assets, extensions: { future: { keep: true } } },
        vendor: { keep: 'opaque' },
    };
}

function archive(files) {
    return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [
        name, typeof bytes === 'string' ? strToU8(bytes) : Uint8Array.from(bytes),
    ])), { level: 0 }));
}

beforeAll(async () => {
    process.env.SILLYTAVERN_API_V1_ENABLED = 'true';
    setConfigFilePath(path.join(serverDirectory, 'default/config.yaml'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-charx-'));
    directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, value)]));
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((request, _response, next) => { request.user = { profile: { ...DEFAULT_USER, handle: 'charx-user' }, directories }; next(); });
    app.use('/api/v1', router);
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

afterAll(async () => {
    delete process.env.SILLYTAVERN_API_V1_ENABLED;
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
});

async function request(endpoint, method = 'GET', body) {
    const response = await fetch(base + endpoint, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

describe('bounded CHARX character cards', () => {
    test('imports card.json, a PNG icon and declared auxiliary assets, then exports a valid archive', async () => {
        const input = card([
            { type: 'icon', name: 'main', ext: 'png', uri: 'embedded://assets/main.png' },
            { type: 'emotion', name: 'Happy', ext: 'png', uri: 'embedded://assets/happy.png' },
        ]);
        const bytes = archive({
            'card.json': JSON.stringify(input),
            'assets/main.png': icon,
            'assets/happy.png': sprite,
        });
        const imported = await request('/characters/import', 'POST', {
            characterId: 'charx-roundtrip', format: 'charx', dataBase64: bytes.toString('base64'),
        });
        expect(imported.status).toBe(201);
        expect(imported.body.raw).toEqual(input);
        expect(fs.readFileSync(path.join(directories.characters, 'charx-roundtrip.png')).subarray(0, 8)).toEqual(icon.subarray(0, 8));
        const assetsDirectory = path.join(directories.userImages, 'charx', 'charx-roundtrip');
        expect(fs.existsSync(path.join(assetsDirectory, '001.png'))).toBe(true);

        const exported = await request('/characters/charx-roundtrip/export?format=charx');
        expect(exported.status).toBe(200);
        expect(exported.body.mimeType).toBe('application/zip');
        expect(exported.body.fileName).toBe('charx-roundtrip.charx');
        const reimported = await request('/characters/import', 'POST', {
            characterId: 'charx-again', format: 'charx', dataBase64: exported.body.dataBase64,
        });
        expect(reimported.status).toBe(201);
        expect(reimported.body.raw.data.extensions).toEqual(input.data.extensions);
        expect(reimported.body.raw.vendor).toEqual(input.vendor);
        expect(reimported.body.raw.data.assets).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'icon', uri: 'embedded://assets/main.png' }),
            expect.objectContaining({ type: 'emotion', name: 'Happy' }),
        ]));
    });

    test('rejects missing assets, traversal, oversized expansion and non-versioned cards', async () => {
        const missing = card([{ type: 'icon', name: 'main', ext: 'png', uri: 'embedded://assets/main.png' }]);
        const cases = [
            archive({ 'card.json': JSON.stringify(missing) }),
            archive({ 'card.json': JSON.stringify(card([{ type: 'emotion', name: 'bad', ext: 'png', uri: 'embedded://../escape.png' }])), 'escape.png': sprite }),
            archive({ 'card.json': JSON.stringify(card([{ type: 'emotion', name: 'huge', ext: 'png', uri: 'embedded://assets/huge.png' }])), 'assets/huge.png': Buffer.alloc(5 * 1024 * 1024) }),
            archive({ 'card.json': JSON.stringify({ name: 'Legacy', vendor: { keep: true } }) }),
            Buffer.from('not a zip'),
        ];
        for (const [index, bytes] of cases.entries()) {
            const result = await request('/characters/import', 'POST', {
                characterId: `charx-invalid-${index}`, format: 'charx', dataBase64: bytes.toString('base64'),
            });
            expect(result.status).toBeGreaterThanOrEqual(400);
            expect((await request(`/characters/charx-invalid-${index}`)).status).toBe(404);
        }
        expect(fs.existsSync(path.join(root, 'escape.png'))).toBe(false);
    });
});
