import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import express from 'express';
import { jest, beforeAll, beforeEach, afterEach, afterAll, test, expect } from '@jest/globals';

// Git is entirely simulated: no external network, package code or dependency manager runs.
let gitMode = 'ok', holdClone, spawnCalls = [];
const commit = 'a'.repeat(40), blobId = 'b'.repeat(40), entryBlobId = 'c'.repeat(40);
const spawn = jest.fn((command, args, options) => {
    spawnCalls.push({ command, args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.emit('close', 1); return true; };
    const complete = () => {
        let output = '';
        if (args.includes('clone')) {
            if (gitMode === 'failure') { child.stderr.write('https://secret.invalid/?key=must-not-leak'); child.emit('close', 1); return; }
            fs.mkdirSync(path.join(options.cwd, 'repo'));
        } else if (args.includes('rev-parse')) output = commit + '\n';
        else if (args.includes('ls-tree')) {
            const manifest = gitMode === 'symlink' ? '120000' : '100644';
            const manifestName = gitMode === 'traversal' ? '../escape' : gitMode === 'plugin' ? 'package.json' : 'manifest.json';
            output = `${manifest} blob ${blobId}\t${manifestName}\0`;
            if (gitMode !== 'symlink' && gitMode !== 'traversal' && gitMode !== 'plugin') output += `100644 blob ${entryBlobId}\tmust-not-execute.js\0`;
        }
        else if (args.includes('cat-file')) output = args.includes(entryBlobId) ? 'module.exports = {};\n' : JSON.stringify({ name: 'fixture', version: '1.0', runtime: 'headless', entry: 'must-not-execute.js', hooks: { beforePrompt: true } });
        child.stdout.write(output); child.emit('close', 0);
    };
    if (gitMode === 'hold' && args.includes('clone')) holdClone = complete;
    else setImmediate(complete);
    return child;
});
jest.unstable_mockModule('node:child_process', () => ({ spawn, exec: jest.fn(), execSync: jest.fn(), spawnSync: jest.fn() }));
const { router } = await import('../dist/src/endpoints/api-v1.js');
const { configurePackagePluginRoot, packageInventory, mutatePackages, validatePackageUrl, packageRestartPending } = await import('../dist/src/headless/package-management.js');
const { createGeneration, clearGenerations, withPackageMaintenance } = await import('../dist/src/headless/generation-store.js');
const { readSettings, writeSettings } = await import('../dist/src/headless/session.js');
const { listExtensions } = await import('../dist/src/headless/prompt-settings.js');
const { readExtensionUi } = await import('../dist/src/headless/extension-ui.js');
const { getConfig, setConfigFilePath } = await import('../dist/src/util.js');
const { serverDirectory } = await import('../dist/src/server-directory.js');
const { USER_DIRECTORY_TEMPLATE, DEFAULT_USER } = await import('../dist/src/constants.js');
let root, session, request, server, url, originalPluginManagement;
beforeAll(() => {
    setConfigFilePath(path.join(serverDirectory, 'default/config.yaml'));
    originalPluginManagement = getConfig().enablePluginManagement;
});
beforeEach(async () => {
    delete getConfig().enablePluginManagement;
    delete process.env.SILLYTAVERN_ENABLEPLUGINMANAGEMENT;
    delete process.env.SILLYTAVERN_COMPANION_MODE;
    process.env.SILLYTAVERN_API_V1_ENABLED = 'true';
    process.env.SILLYTAVERN_ENABLEPACKAGEMANAGEMENT = 'true';
    gitMode = 'ok'; spawnCalls = []; holdClone = undefined;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-package-test-'));
    const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, value)]));
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    configurePackagePluginRoot(path.join(root, 'plugins'));
    session = { handle: 'package-user', directories, extensionSettings: {}, settings: {} };
    writeSettings(directories, readSettings(directories));
    request = { user: { profile: { ...DEFAULT_USER, handle: session.handle, admin: true }, directories } };
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = request.user; next(); }); app.use('/api/v1', router);
    server = await new Promise(resolve => { const result = app.listen(0, '127.0.0.1', () => resolve(result)); });
    url = `http://127.0.0.1:${server.address().port}/api/v1`;
});
afterEach(async () => { clearGenerations(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); delete process.env.SILLYTAVERN_ENABLEPACKAGEMANAGEMENT; delete process.env.SILLYTAVERN_ENABLEPLUGINMANAGEMENT; delete process.env.SILLYTAVERN_API_V1_ENABLED; delete process.env.SILLYTAVERN_COMPANION_MODE; });
afterAll(() => { getConfig().enablePluginManagement = originalPluginManagement; jest.restoreAllMocks(); });
async function inventory() { return packageInventory(request, session); }
async function mutate(body, install = true) { return mutatePackages({ ...request, body: { expectedRevision: (await inventory()).revision, confirmTrust: true, ...body } }, session, install); }
function installBody(name = 'fixture', kind = 'extension') { return { kind, name, url: 'https://example.invalid/repository.git' }; }
function managed(name, kind = 'extension') {
    const directory = path.join(kind === 'extension' ? session.directories.extensions : path.join(root, 'plugins'), name); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, '.st-managed-package.json'), JSON.stringify({ kind, name, repository: 'https://example.invalid/repository.git', commit }));
    fs.writeFileSync(path.join(directory, kind === 'extension' ? 'manifest.json' : 'package.json'), JSON.stringify({ version: 'old' })); return directory;
}

test('policy defaults off and capability advertises only enabled policy', async () => {
    delete process.env.SILLYTAVERN_ENABLEPACKAGEMANAGEMENT;
    expect((await inventory()).enabled).toBe(false);
    expect((await (await fetch(url + '/capabilities')).json()).resources.packageManagement).toBe(false);
    await expect(mutate(installBody())).rejects.toMatchObject({ status: 403 });
    expect(spawnCalls).toHaveLength(0);
});
test('plugin management config enables inventory, capability and mutations', async () => {
    delete process.env.SILLYTAVERN_ENABLEPACKAGEMANAGEMENT;
    getConfig().enablePluginManagement = true;
    expect((await inventory()).enabled).toBe(true);
    expect((await (await fetch(url + '/capabilities')).json()).resources.packageManagement).toBe(true);
    expect((await mutate(installBody())).results[0].ok).toBe(true);
});
test('explicit plugin management disable overrides legacy enable and environment can override config', async () => {
    getConfig().enablePluginManagement = false;
    expect((await inventory()).enabled).toBe(false);
    await expect(mutate(installBody())).rejects.toMatchObject({ status: 403 });
    process.env.SILLYTAVERN_ENABLEPLUGINMANAGEMENT = 'true';
    expect((await inventory()).enabled).toBe(true);
    getConfig().enablePluginManagement = true;
    process.env.SILLYTAVERN_ENABLEPLUGINMANAGEMENT = 'false';
    expect((await (await fetch(url + '/capabilities')).json()).resources.packageManagement).toBe(false);
    await expect(mutate(installBody())).rejects.toMatchObject({ status: 403 });
    expect(spawnCalls).toHaveLength(0);
});
test('legacy management setting still enables inventory, capability and mutations when new key is absent', async () => {
    expect((await inventory()).enabled).toBe(true);
    expect((await (await fetch(url + '/capabilities')).json()).resources.packageManagement).toBe(true);
    expect((await mutate(installBody())).results[0].ok).toBe(true);
});
test('standalone admin authorization applies to inventory and mutations; companion capability is operator', async () => {
    request.user.profile.admin = false;
    expect((await fetch(url + '/package-management')).status).toBe(403);
    await expect(mutatePackages({ ...request, body: {} }, session, true)).rejects.toMatchObject({ status: 403 });
    process.env.SILLYTAVERN_COMPANION_MODE = 'true'; expect((await inventory()).enabled).toBe(true);
});
test.each(['http://example.invalid/x', 'file:///tmp/repo', 'https://user:secret@example.invalid/x', 'https://example.invalid/x?key=secret', 'https://example.invalid/x#secret', 'https://example.invalid/x?', 'https://example.invalid/x#', 'https://example.invalid/\\repo'])('denies unsafe URL %s without starting Git', async value => {
    expect(() => validatePackageUrl(value)).toThrow(); await expect(mutate({ ...installBody(), url: value })).rejects.toMatchObject({ status: 400 }); expect(spawnCalls).toHaveLength(0);
});
test.each(['../escape', '.', '..', '/tmp/escape', 'foo/bar', 'foo.bar', '-option', 'third-party'])('denies unsafe name %s', async name => { await expect(mutate(installBody(name))).rejects.toMatchObject({ status: 400 }); expect(spawnCalls).toHaveLength(0); });
test('requires explicit trust, revision and bounded unique selections', async () => {
    await expect(mutate({ ...installBody(), confirmTrust: false })).rejects.toMatchObject({ status: 400 });
    await expect(mutate({ ...installBody(), expectedRevision: 'stale' })).rejects.toMatchObject({ status: 409 });
    await expect(mutate({ action: 'remove', packages: Array(33).fill({ kind: 'extension', name: 'fixture' }) }, false)).rejects.toMatchObject({ status: 400 });
    await expect(mutate({ action: 'remove', packages: Array(2).fill({ kind: 'extension', name: 'fixture' }) }, false)).rejects.toMatchObject({ status: 400 });
    expect(spawnCalls).toHaveLength(0);
});
test('install is a bounded sanitized Git snapshot, disabled and restart-blocked, never dependency execution', async () => {
    const before = await inventory(); const response = await fetch(url + '/package-management/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...installBody(), expectedRevision: before.revision, confirmTrust: true }) });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ restartRequired: true, results: [{ kind: 'extension', name: 'fixture', ok: true }] });
    const after = await inventory(); expect(after.revision).not.toBe(before.revision); expect(after.packages[0]).toMatchObject({ manageable: true, commit, version: '1.0', repository: 'https://example.invalid/repository.git' });
    expect(readSettings(session.directories).extension_settings.disabledExtensions).toContain('third-party/fixture');
    expect(packageRestartPending(path.join(session.directories.extensions, 'fixture'))).toBe(true);
    expect(listExtensions(session).find(row => row.id === 'local/fixture').enabled).toBe(false);
    await expect(readExtensionUi(session, 'local/fixture')).rejects.toMatchObject({ status: 409 });
    for (const call of spawnCalls) { expect(call.command).toBe('git'); expect(call.args).toEqual(expect.arrayContaining(['core.hooksPath=/dev/null', 'protocol.allow=never', 'protocol.https.allow=always', 'http.followRedirects=false', 'credential.helper='])); expect(call.options.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }); expect(call.options.env).not.toHaveProperty('GIT_CONFIG_COUNT'); }
    expect(fs.existsSync(path.join(session.directories.extensions, 'fixture', '.git'))).toBe(false);
});
test('server plugin installation uses configured loader root, not per-user extension directories', async () => {
    gitMode = 'plugin'; const result = await mutate(installBody('plugin', 'server-plugin'));
    expect(result.results[0].ok).toBe(true); expect(fs.existsSync(path.join(root, 'plugins/plugin/package.json'))).toBe(true); expect(fs.existsSync(path.join(session.directories.extensions, 'plugin'))).toBe(false);
});
test.each(['symlink', 'traversal', 'failure'])('rejects hostile repositories (%s), redacts Git detail, cleans staging', async mode => {
    gitMode = mode; const result = await mutate(installBody()); expect(result.restartRequired).toBe(false); expect(result.results[0].ok).toBe(false); expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(fs.readdirSync(session.directories.extensions)).toEqual([]);
});
test('inventory revision includes changed files, and symlinks/unmanaged entries are never manageable', async () => {
    const directory = managed('fixture'); const first = await inventory(); fs.writeFileSync(path.join(directory, 'local.txt'), 'modified'); expect((await inventory()).revision).not.toBe(first.revision);
    fs.symlinkSync(directory, path.join(session.directories.extensions, 'linked')); fs.mkdirSync(path.join(session.directories.extensions, 'legacy'));
    const rows = (await inventory()).packages; expect(rows.find(row => row.name === 'linked').manageable).toBe(false); expect(rows.find(row => row.name === 'legacy').manageable).toBe(false);
    await expect(mutate({ ...installBody(), expectedRevision: first.revision })).rejects.toMatchObject({ status: 409 });
});
test('bulk is sequential partial results, removes only selected managed packages', async () => {
    managed('one'); managed('two'); fs.mkdirSync(path.join(session.directories.extensions, 'legacy'));
    const response = await mutate({ action: 'remove', packages: [{ kind: 'extension', name: 'one' }, { kind: 'extension', name: 'legacy' }, { kind: 'extension', name: 'two' }] }, false);
    expect(response.results.map(row => row.ok)).toEqual([true, false, true]); expect(response.restartRequired).toBe(true); expect(fs.readdirSync(session.directories.extensions)).toEqual(['legacy']); expect(spawnCalls).toHaveLength(0);
});
test('removal retains the disabled extension marker and no new activation is granted', async () => {
    managed('fixture'); const settings = readSettings(session.directories); settings.extension_settings.disabledExtensions = []; writeSettings(session.directories, settings);
    const result = await mutate({ action: 'remove', packages: [{ kind: 'extension', name: 'fixture' }] }, false);
    expect(result.results[0].ok).toBe(true); expect(readSettings(session.directories).extension_settings.disabledExtensions).toContain('third-party/fixture'); expect(fs.existsSync(path.join(session.directories.extensions, 'fixture'))).toBe(false);
});
test('upgrade disables an existing extension without expanding grants or retaining Git configs', async () => {
    managed('fixture'); const result = await mutate({ action: 'upgrade', packages: [{ kind: 'extension', name: 'fixture' }] }, false);
    expect(result.results[0].ok).toBe(true); expect(readSettings(session.directories).extension_settings.disabledExtensions).toContain('third-party/fixture');
});
test('rejects concurrent writes and new generations, and inventory waits for completion', async () => {
    gitMode = 'hold'; const rev = (await inventory()).revision;
    const pending = mutatePackages({ ...request, body: { ...installBody(), expectedRevision: rev, confirmTrust: true } }, session, true);
    while (!holdClone) await new Promise(resolve => setImmediate(resolve));
    await expect(mutatePackages({ ...request, body: { ...installBody('another'), expectedRevision: rev, confirmTrust: true } }, session, true)).rejects.toMatchObject({ status: 409 });
    expect(() => createGeneration({ handle: session.handle, characterId: 'fixture', chatId: 'chat', directories: session.directories })).toThrow('Package maintenance');
    let readFinished = false; const read = inventory().then(value => { readFinished = true; return value; }); await new Promise(resolve => setImmediate(resolve)); expect(readFinished).toBe(false);
    gitMode = 'ok'; holdClone(); await pending; expect((await read).packages).toHaveLength(1);
});
test('generation maintenance fence is released on exceptions', async () => {
    await expect(withPackageMaintenance(async () => { throw new Error('fixture'); })).rejects.toThrow('fixture');
    await expect(withPackageMaintenance(async () => 'ready')).resolves.toBe('ready');
});
