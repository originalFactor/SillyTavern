import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ApiError, requireObject } from './contract.js';
import { getConfigValue } from '../util.js';
import { serverDirectory } from '../server-directory.js';
import { readSettings, writeSettings, type HeadlessSession } from './session.js';
import { withPackageMaintenance } from './generation-store.js';

export type PackageKind = 'extension' | 'server-plugin';
export interface ManagedPackage { kind: PackageKind; name: string; id: string; version?: string; repository?: string; commit?: string; manageable: boolean; diagnostic?: string }
const MARKER = '.st-managed-package.json';
const MAX_BYTES = 64 * 1024 * 1024, MAX_FILES = 4096;
let pluginRoot = path.join(serverDirectory, 'plugins');
let serial: Promise<unknown> = Promise.resolve();
let mutationPending = false;
const changed = new Set<string>();
const staging = new Set<string>();
export function configurePackagePluginRoot(root: string) { pluginRoot = path.resolve(root); }
export function packageManagementEnabled() {
    const key = getConfigValue('enablePluginManagement', null) === null
        ? 'enablePackageManagement' : 'enablePluginManagement';
    return !!getConfigValue(key, false, 'boolean');
}
export function packageRestartPending(directory: string) { return changed.has(path.resolve(directory)); }
export function isManagedPackage(directory: string) {
    try {
        const dir = fs.lstatSync(directory), marker = fs.lstatSync(path.join(directory, MARKER));
        return dir.isDirectory() && !dir.isSymbolicLink() && marker.isFile() && !marker.isSymbolicLink();
    } catch { return false; }
}
function fail(message: string): never { throw new ApiError(400, 'validation', message); }
function nameOf(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) || ['node_modules', 'third-party'].includes(value)) fail('Package name must be a safe single basename (1–64 letters, digits, underscores or hyphens).');
    return value;
}
function kindOf(value: unknown): PackageKind { if (value !== 'extension' && value !== 'server-plugin') fail('Invalid package kind.'); return value; }
export function validatePackageUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\\\x00-\x1f]/.test(value)) fail('A credential-free HTTPS repository URL is required.');
    let url: URL; try { url = new URL(value); } catch { return fail('Invalid repository URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#') || !url.hostname) fail('Only HTTPS URLs without credentials, query or fragment are allowed.');
    return url.href;
}
function safePath(directory: string, allowMissing = false) {
    const absolute = path.resolve(directory);
    let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep)) {
        current = path.join(current, part);
        try { const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(); }
        catch (error: any) { if (allowMissing && error.code === 'ENOENT') continue; throw new ApiError(422, 'storage', 'Package paths must be real directories without symlinks.'); }
    }
    return absolute;
}
function roots(session: HeadlessSession) { return { extension: safePath(session.directories.extensions, true), 'server-plugin': safePath(pluginRoot, true) }; }
function safePackageTree(directory: string) {
    let count = 0, bytes = 0;
    function visit(dir: string) {
        for (const name of fs.readdirSync(dir)) {
            const file = path.join(dir, name), stat = fs.lstatSync(file);
            if (++count > MAX_FILES || (bytes += stat.size) > MAX_BYTES || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return false;
            if (stat.isDirectory() && !visit(file)) return false;
        }
        return true;
    }
    return visit(directory);
}
function boundedJson(file: string): any {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Invalid metadata');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
// Hash the complete bounded filesystem snapshot, not just directory mtimes or HEAD.
function treeSnapshot(directory: string): string {
    const hash = crypto.createHash('sha256'); let count = 0, bytes = 0;
    function visit(dir: string) {
        for (const name of fs.readdirSync(dir).sort()) {
            const file = path.join(dir, name);
            if (staging.has(file)) continue;
            const stat = fs.lstatSync(file);
            if (++count > MAX_FILES || (bytes += stat.size) > MAX_BYTES) throw new ApiError(413, 'validation', 'Package inventory exceeds filesystem bounds.');
            hash.update(path.relative(directory, file)).update(String(stat.mode)).update(String(stat.mtimeMs));
            if (stat.isSymbolicLink()) { hash.update(fs.readlinkSync(file)); continue; }
            if (stat.isDirectory()) visit(file);
            else if (stat.isFile()) hash.update(fs.readFileSync(file));
            else throw new ApiError(422, 'storage', 'Unsupported package filesystem entry.');
        }
    }
    if (fs.existsSync(directory)) { safePath(directory); visit(directory); }
    return hash.digest('hex');
}
function inspect(session: HeadlessSession) {
    const directories = roots(session), packages: ManagedPackage[] = [], hashes: string[] = [], diagnostics: string[] = [];
    for (const kind of ['extension', 'server-plugin'] as const) {
        const root = directories[kind]; hashes.push(kind, root, treeSnapshot(root));
        if (!fs.existsSync(root)) continue;
        for (const name of fs.readdirSync(root).sort()) {
            if (name.startsWith('.st-package-')) { diagnostics.push(`Hidden package staging ${kind}/${name} needs operator inspection; no package code is loaded from it.`); continue; }
            if (name.startsWith('.')) continue;
            const row: ManagedPackage = { kind, name, id: `${kind}/${name}`, manageable: false };
            try {
                nameOf(name); safePath(path.join(root, name));
                if (!safePackageTree(path.join(root, name))) throw new Error('Package contains unsafe filesystem entries.');
                const metadata = boundedJson(path.join(root, name, MARKER));
                if (metadata.kind !== kind || metadata.name !== name || !/^[a-f0-9]{40,64}$/.test(metadata.commit)) throw new Error();
                row.repository = validatePackageUrl(metadata.repository); row.commit = metadata.commit;
                row.manageable = true;
                try { const manifest = boundedJson(path.join(root, name, kind === 'extension' ? 'manifest.json' : 'package.json')); if (typeof manifest.version === 'string') row.version = manifest.version.slice(0, 128); } catch { /* Optional version. */ }
            } catch { row.diagnostic = 'Not a safely managed package; use operator filesystem tools for legacy or invalid entries.'; }
            packages.push(row);
        }
    }
    return { enabled: packageManagementEnabled(), revision: crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), packages, ...(diagnostics.length ? { diagnostics } : {}) };
}
function authorize(request: any, mutating: boolean) {
    if (!process.env.SILLYTAVERN_COMPANION_MODE && request.user?.profile?.admin !== true) throw new ApiError(403, 'disabled', 'Package management requires an administrator.');
    if (mutating && !packageManagementEnabled()) throw new ApiError(403, 'disabled', 'Package management is disabled by the operator.');
}
export async function packageInventory(request: any, session: HeadlessSession) {
    authorize(request, false); await serial; return inspect(session);
}
function diskUsage(directory: string): number {
    let bytes = 0, files = 0;
    function visit(dir: string) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name), stat = fs.lstatSync(file); if (++files > MAX_FILES || (bytes += stat.size) > MAX_BYTES) throw new Error(); if (entry.isDirectory()) visit(file); } }
    visit(directory); return bytes;
}
// Fresh Git storage only: never read a package's Git config, hooks, filters or worktree.
function git(args: string[], workspace: string, deadline: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const remaining = deadline - Date.now(); if (remaining <= 0) { reject(new Error('Git operation timed out.')); return; }
        const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false', '-c', 'credential.helper=', '-c', 'core.attributesFile=/dev/null', ...args], {
            cwd: workspace, detached: process.platform !== 'win32', env: { PATH: process.env.PATH, HOME: workspace, XDG_CONFIG_HOME: workspace, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', GIT_LFS_SKIP_SMUDGE: '1', GIT_PROTOCOL_FROM_USER: '0', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const chunks: Buffer[] = []; let size = 0, failed = false;
        const stop = () => { failed = true; try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ } };
        const timeout = setTimeout(stop, remaining);
        const monitor = setInterval(() => { try { diskUsage(workspace); } catch { stop(); } }, 25);
        child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8 * 1024 * 1024) stop(); else chunks.push(chunk); });
        child.stderr.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8 * 1024 * 1024) stop(); });
        child.on('error', () => { clearTimeout(timeout); clearInterval(monitor); reject(new Error('Git could not be started.')); });
        child.on('close', code => { clearTimeout(timeout); clearInterval(monitor); if (code !== 0 || failed) reject(new Error('Git failed or exceeded its time, output or disk limit. No automatic retry.')); else resolve(Buffer.concat(chunks)); });
    });
}
async function prepare(repository: string, kind: PackageKind, name: string, workspace: string, mutationDeadline: number) {
    const deadline = Math.min(Date.now() + 20_000, mutationDeadline);
    const emptyTemplate = path.join(workspace, 'empty-template'); fs.mkdirSync(emptyTemplate);
    await git(['clone', '--bare', '--depth=1', '--no-recurse-submodules', '--template', emptyTemplate, '--', repository, 'repo'], workspace, deadline);
    fs.rmSync(emptyTemplate, { recursive: true, force: true });
    diskUsage(workspace);
    const commit = (await git(['--git-dir=repo', 'rev-parse', 'HEAD'], workspace, deadline)).toString().trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid repository commit.');
    const entries = (await git(['--git-dir=repo', 'ls-tree', '-rz', '--full-tree', 'HEAD'], workspace, deadline)).toString('utf8').split('\0').filter(Boolean);
    if (entries.length > MAX_FILES) throw new Error('Repository has too many files.');
    const output = path.join(workspace, 'output'); fs.mkdirSync(output); let total = 0;
    for (const entry of entries) {
        const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(entry);
        if (!match) throw new Error('Symlinks, submodules and unsupported paths are forbidden.');
        const relative = match[3], parts = relative.split('/');
        if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.toLowerCase() === MARKER || /[\\\x00-\x1f]/.test(part)) || path.isAbsolute(relative)) throw new Error('Unsafe repository path.');
        const blob = await git(['--git-dir=repo', 'cat-file', 'blob', match[2]], workspace, deadline);
        if ((total += blob.length) > MAX_BYTES) throw new Error('Repository exceeds the unpacked size limit.');
        const destination = path.join(output, relative); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, blob, { flag: 'wx', mode: 0o600 });
        diskUsage(workspace);
    }
    const manifest = boundedJson(path.join(output, kind === 'extension' ? 'manifest.json' : 'package.json'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('A package manifest object is required.');
    const entry = kind === 'extension' ? manifest.entry : manifest.main;
    if (entry !== undefined) {
        if (typeof entry !== 'string' || !entry || path.isAbsolute(entry) || entry.includes('\\') || entry.split('/').some((part: string) => !part || part === '.' || part === '..') || !/\.(?:mjs|cjs|js)$/.test(entry)) throw new Error('Manifest entry must be a safe relative JavaScript module path.');
        const entryStat = fs.lstatSync(path.join(output, entry), { throwIfNoEntry: false });
        if (!entryStat?.isFile() || entryStat.isSymbolicLink()) throw new Error('Manifest entry is missing or not a regular file.');
    }
    if (!safePackageTree(output)) throw new Error('Package contains unsafe filesystem entries.');
    fs.writeFileSync(path.join(output, MARKER), JSON.stringify({ kind, name, repository, commit }), { flag: 'wx', mode: 0o600 });
    return output;
}
function disableExtension(session: HeadlessSession, name: string) {
    const settings = readSettings(session.directories), ext = settings.extension_settings;
    if (ext.disabledExtensions != null && !Array.isArray(ext.disabledExtensions)) throw new Error('Invalid disabled extension list.');
    ext.disabledExtensions = [...new Set([...(ext.disabledExtensions ?? []), `third-party/${name}`])];
    writeSettings(session.directories, settings);
}
export async function mutatePackages(request: any, session: HeadlessSession, install: boolean) {
    authorize(request, true);
    const body = requireObject(request.body, 'body');
    if (body.confirmTrust !== true) fail('Explicit confirmTrust:true is required. Trusted package code may execute after restart and separate activation.');
    if (typeof body.expectedRevision !== 'string' || !body.expectedRevision) fail('expectedRevision is required.');
    const action = install ? 'install' : body.action;
    if (action !== 'install' && action !== 'upgrade' && action !== 'remove') fail('Invalid package action.');
    const items = install ? [{ kind: body.kind, name: body.name }] : body.packages;
    if (!Array.isArray(items) || items.length === 0 || items.length > 32) fail('Select 1–32 packages.');
    const selected = items.map(item => { requireObject(item, 'package'); return { kind: kindOf(item.kind), name: nameOf(item.name) }; });
    if (new Set(selected.map(item => `${item.kind}/${item.name}`)).size !== selected.length) fail('Duplicate package selection.');
    const repository = install ? validatePackageUrl(body.url) : undefined;
    if (mutationPending) throw new ApiError(409, 'conflict', 'Another package operation is running. Reload after it finishes; do not retry automatically.');
    mutationPending = true;
    const mutationDeadline = Date.now() + 90_000;
    const run = serial.catch(() => {}).then(() => withPackageMaintenance(async () => {
        let current = inspect(session);
        if (body.expectedRevision !== current.revision) throw new ApiError(409, 'conflict', 'Package inventory changed. Reload explicitly; do not retry automatically.');
        if (selected.some(item => changed.has(path.resolve(path.join(roots(session)[item.kind], item.name))))) throw new ApiError(409, 'conflict', 'This package changed during the current process. Restart and inspect before another operation.');
        const results: { kind: PackageKind; name: string; ok: boolean; message: string }[] = [];
        let restartRequired = false;
        for (const item of selected) {
            if (Date.now() >= mutationDeadline) { results.push({ ...item, ok: false, message: 'Not attempted: the 90-second batch deadline was reached. No automatic retry.' }); continue; }
            let workspace: string | undefined;
            let fileMutation = false;
            try {
                const root = roots(session)[item.kind], target = path.join(root, item.name);
                const existing = current.packages.find(row => row.kind === item.kind && row.name === item.name);
                if (action === 'install' ? fs.existsSync(target) : !existing?.manageable) throw new Error(action === 'install' ? 'Package already exists.' : 'Package is not safely manageable.');
                if (action === 'remove') {
                    safePath(target);
                    if (item.kind === 'extension') disableExtension(session, item.name);
                    workspace = fs.mkdtempSync(path.join(root, '.st-package-')); staging.add(workspace);
                    changed.add(target); fs.renameSync(target, path.join(workspace, 'removed')); fileMutation = true; restartRequired = true;
                } else {
                    // Sibling staging avoids cross-device publication. Hidden staging is never loaded.
                    fs.mkdirSync(root, { recursive: true }); safePath(root);
                    workspace = fs.mkdtempSync(path.join(root, '.st-package-'));
                    staging.add(workspace);
                    const output = await prepare(repository ?? existing!.repository!, item.kind, item.name, workspace, mutationDeadline);
                    if (inspect(session).revision !== current.revision) throw new ApiError(409, 'conflict', 'Package files changed during preparation. Reload explicitly.');
                    if (item.kind === 'extension') disableExtension(session, item.name);
                    changed.add(target);
                    if (action === 'upgrade') { safePath(target); fs.renameSync(target, path.join(workspace, 'previous')); fileMutation = true; }
                    try { fs.renameSync(output, target); } catch (error) {
                        if (action === 'upgrade') {
                            try { fs.renameSync(path.join(workspace, 'previous'), target); }
                            catch { staging.delete(workspace); workspace = undefined; restartRequired = true; throw new Error('Publication and rollback failed. Hidden staging was retained for operator inspection; restart required.'); }
                        }
                        throw error;
                    }
                    fileMutation = true;
                    restartRequired = true;
                }
                results.push({ ...item, ok: true, message: 'Package files changed. Restart required; dependencies were not installed and no code was executed.' });
            } catch (error) {
                results.push({ ...item, ok: false, message: error instanceof ApiError ? error.message : error instanceof Error && !('code' in error) ? error.message : 'Package filesystem operation failed. Inspect inventory before any explicit retry.' });
            } finally {
                if (workspace) {
                    let cleaned = true;
                    try { fs.rmSync(workspace, { recursive: true, force: true }); }
                    catch { cleaned = false; /* Preserve the completed result; hidden staging needs operator inspection. */ }
                    staging.delete(workspace);
                    if (!cleaned) {
                        const result = results.at(-1);
                        if (result?.kind === item.kind && result.name === item.name) { result.ok = false; result.message = 'Operation may have changed files, but hidden staging cleanup failed. Reload inventory and inspect its diagnostics before any retry.'; }
                        if (changed.has(path.resolve(path.join(roots(session)[item.kind], item.name)))) restartRequired = true;
                    }
                }
            }
            try { current = inspect(session); }
            catch (error) {
                const message = error instanceof Error ? error.message : 'Package inventory became unavailable.';
                for (const remaining of selected.slice(results.length)) results.push({ ...remaining, ok: false, message: `Not attempted: inventory became uncertain (${message}). Reload and inspect before retrying.` });
                break;
            }
        }
        return { results, restartRequired };
    }));
    serial = run.catch(() => {}).finally(() => { mutationPending = false; }); return run;
}
