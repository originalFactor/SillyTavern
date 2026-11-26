import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { init, parse } from 'es-module-lexer';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { readExtensionUi, readExtensionSettings, saveExtensionSettings } from '../dist/src/headless/extension-ui.js';
import { USER_DIRECTORY_TEMPLATE } from '../dist/src/constants.js';

let root, directory, session;
function install(manifest = {}, source = '') {
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ js: 'index.js', ...manifest }));
    fs.writeFileSync(path.join(directory, 'index.js'), source);
}
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-extension-ui-'));
    directory = path.join(root, 'extensions', 'demo'); fs.mkdirSync(directory, { recursive: true });
    const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, value)]));
    for (const directoryPath of Object.values(directories)) fs.mkdirSync(directoryPath, { recursive: true });
    session = { directories };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({ extension_settings: { demo: { enabled: false, nested: { keep: true }, api_key: 'hidden-value' } }, oai_settings: { model: 'keep-provider' } }));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('bounded extension UI snapshots', () => {
    test.each([
        `import { value } from './child.js';`,
        'import { value } from "./child.js";',
        `import './child.js';`,
        'import "./child.js";',
        `export { value } from './child.js';`,
        'export { value as renamed } from "./child.js";',
        `export * from './child.js';`,
        'export * as child from "./child.js";',
        String.raw`import { value } from './chi\u006cd.js';`,
        `export const later = () => import('./child.js');`,
        'export const later = () => import("./child.js");',
        'export const later = () => import(`./child.js`);',
    ])('rewrites exactly one string literal and produces valid module syntax: %s', async source => {
        install({}, source);
        fs.writeFileSync(path.join(directory, 'child.js'), 'export const value = 42;');
        const bundle = await readExtensionUi(session, 'local/demo');
        const rewritten = bundle.modules[bundle.entries[0]];
        // A substring assertion misses quoted URLs and double-quoted syntax
        // errors. Compile without executing, and inspect the decoded specifier.
        expect(() => new vm.SourceTextModule(rewritten)).not.toThrow();
        await init;
        const [imports] = parse(rewritten);
        expect(imports.map(item => item.specifier)).toEqual([bundle.base + 'child.js']);
        expect(bundle.modules[bundle.base + 'child.js']).toBe('export const value = 42;');
    });
    test('preserves import.meta, comments and unrelated strings while rewriting mixed module edges', async () => {
        const untouched = `const text = 'https://unchanged.invalid/'; /* import "./missing.js" */ export const ownUrl = import.meta.url;`;
        install({}, `import { value } from "./child.js"; ${untouched} export * from './child.js'; export const later=()=>import( /* keep */ \`./child.js\` );`);
        fs.writeFileSync(path.join(directory, 'child.js'), 'export const value = 42;');
        const bundle = await readExtensionUi(session, 'local/demo');
        const rewritten = bundle.modules[bundle.entries[0]];
        expect(() => new vm.SourceTextModule(rewritten)).not.toThrow();
        expect(rewritten).toContain(untouched);
        expect(rewritten).toContain('import( /* keep */ ');
        await init;
        const [imports] = parse(rewritten);
        expect(imports.filter(item => item.type !== 'import-meta').map(item => item.specifier)).toEqual(Array(3).fill(bundle.base + 'child.js'));
    });
    test('stops template discovery at depth four without rejecting unrelated deeper source trees', async () => {
        install({}, 'export const loaded = true;');
        fs.mkdirSync(path.join(directory, 'a/b/c/d/e/f'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'a/b/c/d/boundary.html'), '<p>Included</p>');
        fs.writeFileSync(path.join(directory, 'a/b/c/d/e/hidden.html'), '<p>Not discovered</p>');
        fs.writeFileSync(path.join(directory, 'a/b/c/d/e/f/source.js'), 'throw Error("never evaluated")');
        fs.symlinkSync(root, path.join(directory, 'a/b/c/d/outside'));
        const bundle = await readExtensionUi(session, 'local/demo');
        expect(bundle.templates).toEqual({ 'a/b/c/d/boundary.html': '<p>Included</p>' });
        expect(Object.keys(bundle.modules)).toHaveLength(1);
    });
    test('retains directory inventory bounds while ignoring deeper template subtrees', async () => {
        install(); fs.mkdirSync(path.join(directory, 'assets'));
        for (let i = 0; i < 513; i++) fs.writeFileSync(path.join(directory, 'assets', `item-${i}.txt`), '');
        await expect(readExtensionUi(session, 'local/demo')).rejects.toMatchObject({ status: 413, message: 'Extension directory is too large.' });
    });
    test('packages the upstream regex engine virtual module without granting native writes', async () => {
        install({}, "import { getRegexedString, regex_placement, RegexProvider } from '../../../extensions/regex/engine.js';");
        const bundle = await readExtensionUi(session, 'local/demo');
        expect(bundle.modules[bundle.entries[0]]).toContain('https://extension.invalid/scripts/extensions/regex/engine.js');
    });
    test('packages upstream preset-manager factory imports without enabling preset writes', async () => {
        install({}, "import { getPresetManager, initPresetManager } from '../../../preset-manager.js';");
        const bundle = await readExtensionUi(session, 'local/demo');
        expect(bundle.modules[bundle.entries[0]]).toContain('https://extension.invalid/scripts/preset-manager.js');
    });
    test('packages OpenAI data models and parsers without exposing legacy backend routes', async () => {
        install({}, "import { ChatCompletion, Message, MessageCollection, getChatCompletionModel, getStreamingReply, oai_settings } from '../../../openai.js';");
        const bundle = await readExtensionUi(session, 'local/demo');
        expect(bundle.modules[bundle.entries[0]]).toContain('https://extension.invalid/scripts/openai.js');
    });
    test('packages legacy macro registry and no-chat message helper at the upstream path', async () => {
        install({}, "import { MacrosParser, getLastMessageId } from '../../../macros.js';");
        const bundle = await readExtensionUi(session, 'local/demo');
        expect(bundle.modules[bundle.entries[0]]).toContain('https://extension.invalid/scripts/macros.js');
    });
    test('packages local module graphs, cycles, templates, CSS and upstream host imports without evaluating code', async () => {
        install({ css: 'style.css', activate: 'init' }, `import { extension_settings } from '../../../extensions.js'; import './child.js'; export async function init(){throw new Error('never executed on server')}; export const later=()=>import('./child.js');`);
        fs.writeFileSync(path.join(directory, 'child.js'), "import './index.js'; export const child=true;");
        fs.writeFileSync(path.join(directory, 'settings.html'), '<label>{{name}}<input></label>');
        fs.writeFileSync(path.join(directory, 'style.css'), 'label{display:block}');
        const bundle = await readExtensionUi(session, 'local/demo');
        expect(bundle.entries).toEqual([bundle.base + 'index.js']);
        expect(Object.keys(bundle.modules)).toHaveLength(2);
        for (const source of Object.values(bundle.modules)) expect(() => new vm.SourceTextModule(source)).not.toThrow();
        expect(bundle.modules[bundle.entries[0]]).toContain('https://extension.invalid/scripts/extensions.js');
        expect(bundle.modules[bundle.entries[0]]).toContain(`import("${bundle.base}child.js")`);
        expect(bundle.templates['settings.html']).toContain('{{name}}');
        expect(bundle.libraries.purify).toContain('DOMPurify');
        expect(bundle.libraries.jquery).toContain('jQuery');
        expect(bundle.activate).toBe('init');
    });
    test.each(["import 'https://elsewhere.invalid/x.js'", "import '../../../../secret.js'", "import(foo)", "import(`./${foo}.js`)"] )('rejects unsupported module imports: %s', async source => {
        install({}, source);
        await expect(readExtensionUi(session, 'local/demo')).rejects.toMatchObject({ status: 422 });
    });
    test('keeps upstream third-party path depth and distinct host module identities', async () => {
        install({}, `import { getContext } from '../../../st-context.js'; import { eventSource } from '../../../events.js'; import { t } from '../../../i18n.js'; import { lodash } from '../../../../lib.js';`);
        const bundle = await readExtensionUi(session, 'local/demo');
        expect(bundle.base).toBe('https://extension.invalid/scripts/extensions/third-party/demo/');
        expect(bundle.modules[bundle.entries[0]]).toContain('https://extension.invalid/scripts/st-context.js');
        expect(bundle.modules[bundle.entries[0]]).toContain('https://extension.invalid/lib.js');
        expect(bundle.libraries.lodash).toContain('lodash');
        expect(bundle.libraries.moment).toContain('moment');
        expect(bundle.libraries.bowser).toContain('bowser');
    });
    test('defers unsupported literal host imports until invocation while blocking external dynamic imports', async () => {
        install({}, "export const optional=()=>import('../../../macros/engine/MacroRegistry.js');");
        const bundle = await readExtensionUi(session, 'local/demo');
        const unavailable = bundle.modules['https://extension.invalid/scripts/macros/engine/MacroRegistry.js'];
        expect(unavailable).toContain('throw new Error');
        expect(unavailable).toContain('Unsupported extension host module: /scripts/macros/engine/MacroRegistry.js');
        install({}, "import '../../../macros/engine/MacroRegistry.js';");
        await expect(readExtensionUi(session, 'local/demo')).rejects.toMatchObject({ status: 422 });
        install({}, "export const external=()=>import('https://elsewhere.invalid/module.js');");
        await expect(readExtensionUi(session, 'local/demo')).rejects.toMatchObject({ status: 422 });
    });
    test('packages explicit runtime data-model, streaming and World Info imports without executing them', async () => {
        install({}, `import { Prompt, PromptCollection } from '../../../PromptManager.js'; import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js'; import { SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js'; import { getEventSourceStream } from '../../../sse-stream.js'; import { loadWorldInfo } from '../../../world-info.js';`);
        const bundle = await readExtensionUi(session, 'local/demo');
        for (const module of ['PromptManager.js', 'slash-commands/SlashCommandParser.js', 'slash-commands/SlashCommandArgument.js', 'sse-stream.js', 'world-info.js']) expect(bundle.modules[bundle.entries[0]]).toContain(`https://extension.invalid/scripts/${module}`);
    });
    test('accepts static tokenizer imports at the upstream path for length-based client estimation', async () => {
        install({}, `import { getTokenCountAsync, getTokenCount, guesstimate } from '../../../tokenizers.js';`);
        const bundle = await readExtensionUi(session, 'local/demo');
        expect(bundle.modules[bundle.entries[0]]).toContain('https://extension.invalid/scripts/tokenizers.js');
    });
    test('packages Persona and reasoning adapters at upstream import paths', async () => {
        install({}, `import { user_avatar, getUserAvatars, setUserAvatar } from '../../../personas.js'; import { extractReasoningFromData } from '../../../reasoning.js';`);
        const bundle = await readExtensionUi(session, 'local/demo');
        for (const module of ['personas.js', 'reasoning.js']) expect(bundle.modules[bundle.entries[0]]).toContain(`https://extension.invalid/scripts/${module}`);
    });
    test('packages upstream account helpers without exposing legacy user-management routes', async () => {
        install({}, "import { isAdmin, getCurrentUserHandle, accountsEnabled } from '../../../user.js';");
        const bundle = await readExtensionUi(session, 'local/demo');
        expect(bundle.modules[bundle.entries[0]]).toContain('https://extension.invalid/scripts/user.js');
        install({}, "import '../../../users.js';");
        await expect(readExtensionUi(session, 'local/demo')).rejects.toMatchObject({ status: 422 });
    });
    test('packages Author note metadata, device helpers and constants without granting chat access', async () => {
        install({}, `import { NOTE_MODULE_NAME, metadata_keys, shouldWIAddPrompt } from '../../../authors-note.js'; import { isMobile } from '../../../RossAscends-mods.js'; import { debounce_timeout } from '../../../constants.js';`);
        const bundle = await readExtensionUi(session, 'local/demo');
        for (const file of ['authors-note.js', 'RossAscends-mods.js', 'constants.js']) expect(bundle.modules[bundle.entries[0]]).toContain(`https://extension.invalid/scripts/${file}`);
    });
    test('rejects symlinks, oversized assets, traversal and no-UI manifests', async () => {
        install(); fs.unlinkSync(path.join(directory, 'index.js'));
        fs.writeFileSync(path.join(root, 'outside.js'), 'outside'); fs.symlinkSync(path.join(root, 'outside.js'), path.join(directory, 'index.js'));
        await expect(readExtensionUi(session, 'local/demo')).rejects.toMatchObject({ status: 404 });
        fs.unlinkSync(path.join(directory, 'index.js')); install({}, ' '.repeat(4 * 1024 * 1024 + 1));
        await expect(readExtensionUi(session, 'local/demo')).rejects.toMatchObject({ status: 413, message: 'Extension asset "index.js" exceeds 4 MiB.' });
        install({ js: '../outside.js' });
        await expect(readExtensionUi(session, 'local/demo')).rejects.toMatchObject({ status: 400 });
        install({ js: [] });
        await expect(readExtensionUi(session, 'local/demo')).rejects.toMatchObject({ status: 422 });
    });
    test('loads bundled JavaScript larger than 512 KiB through the inclusive 4 MiB boundary', async () => {
        const source = 'export const bundled = true;'.padEnd(4 * 1024 * 1024, ' ');
        expect(Buffer.byteLength(source)).toBe(4 * 1024 * 1024);
        install({}, source);
        const bundle = await readExtensionUi(session, 'local/demo');
        expect(bundle.modules[bundle.entries[0]]).toBe(source);
    });
    test('retains the aggregate source bound for individually valid assets', async () => {
        install({ css: 'style.css' }, ' '.repeat(3 * 1024 * 1024));
        fs.writeFileSync(path.join(directory, 'style.css'), ' '.repeat(1024 * 1024 + 1));
        await expect(readExtensionUi(session, 'local/demo')).rejects.toMatchObject({ status: 413, message: 'Extension UI exceeds 4 MiB.' });
    });
    test('keeps manifests bounded to 512 KiB', async () => {
        install({ description: 'x'.repeat(512 * 1024) });
        await expect(readExtensionUi(session, 'local/demo')).rejects.toMatchObject({ status: 413, message: 'Extension asset "manifest.json" exceeds 512 KiB.' });
    });
    test('rejects directory assets before reading them', async () => {
        install({ js: 'folder.js' });
        fs.mkdirSync(path.join(directory, 'folder.js'));
        await expect(readExtensionUi(session, 'local/demo')).rejects.toMatchObject({ status: 413, message: 'Extension asset "folder.js" is not a regular file.' });
    });
});

describe('scoped revision-checked settings bridge', () => {
    test('maps inventory IDs to settings namespaces, redacts credentials, preserves other fields and rejects stale writes', () => {
        install();
        const current = readExtensionSettings(session, 'local/demo');
        expect(current.namespace).toBe('demo'); expect(current.settings.api_key).toBe('[redacted]');
        const saved = saveExtensionSettings(session, 'local/demo', { enabled: true }, current.revision);
        expect(saved.revision).not.toBe(current.revision);
        const stored = JSON.parse(fs.readFileSync(path.join(session.directories.root, 'settings.json')));
        expect(stored.extension_settings.demo.api_key).toBe('hidden-value');
        expect(stored.extension_settings.demo.nested).toEqual({ keep: true });
        expect(stored.oai_settings.model).toBe('keep-provider');
        expect(() => saveExtensionSettings(session, 'local/demo', { enabled: false }, current.revision)).toThrow('Reload');
        expect(() => saveExtensionSettings(session, 'local/demo', { api_key: 'new' }, saved.revision)).toThrow('Credential');
        expect(() => saveExtensionSettings(session, 'local/demo', JSON.parse('{"__proto__":{"polluted":true}}'), saved.revision)).toThrow('reserved');
    });
    test('supports explicit namespace aliases but never arbitrary uninstalled IDs or reserved namespaces', () => {
        install({ settings_namespace: 'alias' });
        expect(readExtensionSettings(session, 'local/demo').namespace).toBe('alias');
        expect(() => readExtensionSettings(session, 'local/missing')).toThrow('not found');
        expect(() => readExtensionSettings(session, 'local/../demo')).toThrow('Invalid extension ID');
        install({ settings_namespace: '__proto__' });
        expect(() => readExtensionSettings(session, 'local/demo')).toThrow('Reserved');
    });
});
