import fs from 'node:fs';
import { File } from 'node:buffer';
import ts from 'typescript';
import { describe, expect, test } from '@jest/globals';

// Keep the dependency-free client helpers under the existing Node test runner.
const source = fs.readFileSync(new URL('../client/lib/presets.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const exports = {};
new Function('exports', outputText)(exports);
const { MAX_PRESET_BYTES, parsePreset, presetPath, presetSaveBody, readPresetFile, validatePresetName } = exports;

describe('client preset editing and import', () => {
    test('imports BOM-prefixed UTF-8 JSON and retains opaque prompt/card extension fields', async () => {
        const preset = { temperature: 0.42, prompts: [{ identifier: 'main', content: '你好 {{user}}', extension: { keep: true } }], vendor: { future: [null, false, 3] } };
        const imported = await readPresetFile(new File(['\uFEFF' + JSON.stringify(preset)], '原生预设 🙂.JSON'));
        expect(imported.name).toBe('原生预设 🙂');
        expect(JSON.parse(imported.text)).toEqual(preset);
        expect(presetSaveBody(imported.name, imported.text, null)).toEqual({ preset });
        expect(presetPath('chat-completion', imported.name)).toBe('/presets/chat-completion/' + encodeURIComponent(imported.name));
    });

    test('uses only the inspected revision for edits; renamed copies never reuse that revision', () => {
        const inspected = { name: 'Inspected', revision: 'old-file-revision' };
        expect(presetSaveBody('Inspected', '{"temperature":0.5}', inspected)).toEqual({ preset: { temperature: 0.5 }, expectedRevision: 'old-file-revision' });
        expect(presetSaveBody('Copy', '{"temperature":0.5}', inspected)).toEqual({ preset: { temperature: 0.5 } });
        expect(presetSaveBody('Inspected', '{}', null)).toEqual({ preset: {} });
    });

    test.each(['[]', 'null', 'false', '123', '"text"', '{bad json', '{} trailing'])('rejects malformed/non-object input: %s', text => {
        expect(() => parsePreset(text)).toThrow();
    });

    test('bounds UTF-8 byte size before parsing or reading a file', async () => {
        const oversized = JSON.stringify({ prompt: '你'.repeat(Math.ceil(MAX_PRESET_BYTES / 3)) });
        expect(() => parsePreset(oversized)).toThrow('1 MiB');
        let read = false;
        await expect(readPresetFile({ size: MAX_PRESET_BYTES + 1, arrayBuffer() { read = true; } })).rejects.toThrow('1 MiB');
        expect(read).toBe(false);
        expect(parsePreset('{}' + ' '.repeat(MAX_PRESET_BYTES - 2))).toEqual({});
    });

    test('rejects invalid UTF-8 rather than replacing prompt bytes', async () => {
        await expect(readPresetFile(new File([new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125])], 'bad.json'))).rejects.toThrow('UTF-8');
    });

    test.each(['', ' name', 'name ', '../escape', 'a/b', 'a\\b', 'a:b', 'ending.', 'a\u0000b', '你'.repeat(67)])('rejects unsafe or overlong names', name => {
        expect(() => validatePresetName(name)).toThrow();
    });

    test('does not remove credential-bearing fields silently; backend validation remains authoritative', () => {
        expect(parsePreset('{"custom_include_headers":"Authorization: secret"}')).toEqual({ custom_include_headers: 'Authorization: secret' });
    });
});
