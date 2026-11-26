import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../client/lib/package-management.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const exports = {};
new Function('exports', outputText)(exports);
const { installPlan, bulkPlan, packageKey, packageRequest } = exports;

describe('client plugin management plans', () => {
    test.each(['extension', 'server-plugin'])('uses a revision-bound, explicitly trusted install for %s', kind => {
        const plan = installPlan(kind, ' my-plugin ', ' https://example.test/team/plugin.git ');
        expect(packageRequest(plan, 'inspected-revision')).toEqual({ path: '/package-management/install', body: {
            kind, name: 'my-plugin', url: 'https://example.test/team/plugin.git', expectedRevision: 'inspected-revision', confirmTrust: true,
        } });
    });
    test.each(['http://example.test/plugin', 'file:///tmp/plugin', 'ssh://example.test/plugin', 'https://user:secret@example.test/plugin', 'https://example.test/plugin?token=secret', 'https://example.test/plugin#secret', 'not a URL'])('rejects unsafe repository source %s', url => {
        expect(() => installPlan('extension', 'plugin', url)).toThrow('HTTPS');
    });
    test.each(['', '../plugin', 'a/b', 'a\\b', '.hidden', '-option', 'a b', 'a'.repeat(65)])('rejects unsafe install folder %s', name => {
        expect(() => installPlan('extension', name, 'https://example.test/plugin')).toThrow('folder name');
    });
    test.each(['upgrade', 'remove'])('captures exact identities for bulk %s without conflating kinds', action => {
        const extension = { kind: 'extension', name: 'same', id: 'local/same', manageable: true };
        const server = { kind: 'server-plugin', name: 'same', id: 'same', manageable: true };
        const readOnly = { kind: 'extension', name: 'builtin', id: 'builtin', manageable: false };
        const selected = new Set([packageKey(extension), packageKey(server), packageKey(readOnly), 'missing']);
        const plan = bulkPlan(action, [extension, server, readOnly], selected);
        selected.clear();
        extension.name = 'changed';
        expect(packageRequest(plan, 'revision')).toEqual({ path: '/package-management/bulk', body: {
            action, packages: [{ kind: 'extension', name: 'same' }, { kind: 'server-plugin', name: 'same' }], expectedRevision: 'revision', confirmTrust: true,
        } });
    });
    test('bounds bulk selection to 32 items', () => {
        const items = Array.from({ length: 33 }, (_, index) => ({ kind: 'extension', name: `plugin-${index}`, manageable: true }));
        expect(() => bulkPlan('upgrade', items, new Set(items.map(packageKey)))).toThrow('32');
        expect(bulkPlan('upgrade', items.slice(0, 32), new Set(items.map(packageKey))).packages).toHaveLength(32);
    });
    test('rejects empty bulk actions and missing inspected revisions', () => {
        expect(() => bulkPlan('remove', [], new Set())).toThrow('Select');
        expect(() => packageRequest(installPlan('extension', 'plugin', 'https://example.test/plugin'), '')).toThrow('Reload');
    });
});
