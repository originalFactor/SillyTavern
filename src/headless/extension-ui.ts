import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { init, parse } from 'es-module-lexer';
import { ApiError, requireSafeId } from './contract.js';
import { serverDirectory } from '../server-directory.js';
import { hasCredentialValues, isCredentialField, publicConfiguration } from './redaction.js';
import { readSettings, writeSettings, type HeadlessSession } from './session.js';
import { packageRestartPending } from './package-management.js';
import { EXTENSION_HOST_MODULES } from './extension-host-contract.js';

const require = createRequire(import.meta.url);
const ORIGIN = 'https://extension.invalid';
const MAX_MANIFEST = 512 * 1024;
const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype', 'disabledExtensions']);
const hash = (value: any) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isObject = (value: any) => value && typeof value === 'object' && !Array.isArray(value);

/** Resolve one installed extension, never an arbitrary settings namespace or directory. */
export function extensionTarget(session: HeadlessSession, id: string) {
    const parts = id.split('/');
    if (parts.length > 2 || parts.length === 2 && !['local', 'global'].includes(parts[0])) throw new ApiError(400, 'validation', 'Invalid extension ID.');
    parts.forEach(part => requireSafeId(part, 'extensionId'));
    const name = parts.at(-1)!;
    const root = parts.length === 1 ? path.join(serverDirectory, 'compat-source/upstream/scripts/extensions')
        : parts[0] === 'local' ? session.directories.extensions : path.join(serverDirectory, 'compat-source/upstream/scripts/extensions/third-party');
    const directory = path.resolve(root, name);
    const manifest = JSON.parse(readRegular(directory, 'manifest.json', MAX_MANIFEST));
    const namespace = requireSafeId(manifest.settings_namespace ?? name, 'settings namespace');
    if (RESERVED.has(namespace)) throw new ApiError(400, 'validation', 'Reserved extension settings namespace.');
    return { directory, manifest, namespace, name };
}

/** No-follow each path component, including the extension root. Never serve directories or symlinks. */
function readRegular(directory: string, relative: string, limit = MAX_FILE) {
    if (!relative || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new ApiError(400, 'validation', 'Invalid extension asset path.');
    let filename = directory;
    const root = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!root?.isDirectory() || root.isSymbolicLink()) throw new ApiError(404, 'not_found', 'Extension not found.');
    for (const part of relative.split('/')) {
        filename = path.join(filename, part);
        const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
        if (!stat || stat.isSymbolicLink()) throw new ApiError(404, 'not_found', 'Extension asset missing or symlinked.');
        if (filename !== path.join(directory, relative) && !stat.isDirectory()) throw new ApiError(400, 'validation', 'Invalid asset directory.');
        if (filename === path.join(directory, relative) && !stat.isFile()) throw new ApiError(413, 'validation', `Extension asset "${relative}" is not a regular file.`);
    }
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new ApiError(413, 'validation', `Extension asset "${relative}" is not a regular file.`);
        const oversized = () => new ApiError(413, 'validation', `Extension asset "${relative}" exceeds ${limit === MAX_MANIFEST ? '512 KiB' : '4 MiB'}.`);
        if (stat.size > limit) throw oversized();
        // Bound the read itself even if a file grows after fstat.
        const buffer = Buffer.alloc(limit + 1);
        let size = 0;
        while (size < buffer.length) {
            const bytes = fs.readSync(fd, buffer, size, buffer.length - size, null);
            if (!bytes) break;
            size += bytes;
        }
        if (size > limit) throw oversized();
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    } finally { fs.closeSync(fd); }
}

export function readExtensionSettings(session: HeadlessSession, id: string, settings = readSettings(session.directories)) {
    const { namespace } = extensionTarget(session, id);
    const value = Object.hasOwn(settings.extension_settings ?? {}, namespace) ? settings.extension_settings[namespace] : {};
    if (Buffer.byteLength(JSON.stringify(value)) > 1_048_576) throw new ApiError(413, 'validation', 'Extension settings exceed 1 MiB.');
    return { extensionId: id, namespace, revision: hash(value), settings: publicConfiguration(value) };
}

export function saveExtensionSettings(session: HeadlessSession, id: string, patch: any, expectedRevision?: string) {
    if (!isObject(patch) || Buffer.byteLength(JSON.stringify(patch)) > 1_048_576) throw new ApiError(400, 'validation', 'Extension settings patch must be an object of at most 1 MiB.');
    const settings = readSettings(session.directories);
    const current = readExtensionSettings(session, id, settings);
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new ApiError(409, 'conflict', 'Extension settings changed. Reload before saving.');
    const stored = settings.extension_settings?.[current.namespace] ?? {};
    if (!isObject(stored)) throw new ApiError(422, 'unsupported', 'This extension uses a non-object namespace; use its dedicated management API.');
    for (const [key, value] of Object.entries(patch)) {
        if (RESERVED.has(key) || isCredentialField(key) || hasCredentialValues(value) || hasCredentialValues(stored[key])) throw new ApiError(400, 'validation', 'Credential and reserved fields are not editable through the extension host.');
    }
    const next = { ...stored, ...patch };
    if (Buffer.byteLength(JSON.stringify(next)) > 1_048_576) throw new ApiError(413, 'validation', 'Extension settings exceed 1 MiB.');
    settings.extension_settings ??= {};
    settings.extension_settings[current.namespace] = next;
    writeSettings(session.directories, settings);
    return readExtensionSettings(session, id, settings);
}

/** Snapshot manifest-declared assets and local module imports as data, not executable server code. */
export async function readExtensionUi(session: HeadlessSession, id: string) {
    const { directory, manifest, name, namespace } = extensionTarget(session, id);
    if (packageRestartPending(directory)) throw new ApiError(409, 'conflict', 'Restart required before loading changed extension code.');
    await init;
    if (packageRestartPending(directory)) throw new ApiError(409, 'conflict', 'Restart required before loading changed extension code.');
    const base = `${ORIGIN}/scripts/extensions/${id.includes('/') ? 'third-party/' : ''}${encodeURIComponent(name)}/`;
    const modules: Record<string, string> = Object.create(null);
    const templates: Record<string, string> = Object.create(null);
    let total = 0;
    let count = 0;
    const load = (file: string) => {
        if (++count > 128) throw new ApiError(413, 'validation', 'Extension UI exceeds 128 assets.');
        const text = readRegular(directory, file);
        total += Buffer.byteLength(text);
        if (total > MAX_TOTAL) throw new ApiError(413, 'validation', 'Extension UI exceeds 4 MiB.');
        return text;
    };
    const shimPaths = new Set<string>(EXTENSION_HOST_MODULES);
    const visit = (file: string): string => {
        const url = new URL(file, base).href;
        if (Object.hasOwn(modules, url)) return url;
        const source = load(file);
        modules[url] = '';
        const [imports] = parse(source);
        let rewritten = source;
        for (const item of [...imports].reverse()) {
            if (item.type === 'import-meta') continue; // blob URLs are intentionally not asset URLs
            if (!item.specifier || item.type === 'dynamic' && item.glob || item.phase) throw new ApiError(422, 'unsupported', 'Computed or non-evaluation module imports are unavailable in the isolated extension host.');
            const resolved = new URL(item.specifier, url);
            if (resolved.origin !== ORIGIN || resolved.search || resolved.hash) throw new ApiError(422, 'unsupported', `External module imports are unavailable: ${item.specifier}`);
            if (resolved.href.startsWith(base)) {
                const relative = decodeURIComponent(resolved.href.slice(base.length));
                if (!/\.(?:js|mjs)$/.test(relative)) throw new ApiError(422, 'unsupported', 'Only local JavaScript module imports are supported.');
                visit(relative);
            } else if (!shimPaths.has(resolved.pathname)) {
                if (item.type !== 'dynamic') throw new ApiError(422, 'unsupported', `Unsupported host module: ${item.specifier}`);
                // A conditional import is not a startup dependency. Package a throwing
                // module so its promise rejects only when invoked, without any fetch.
                if (!Object.hasOwn(modules, resolved.href)) {
                    if (++count > 128) throw new ApiError(413, 'validation', 'Extension UI exceeds 128 assets.');
                    modules[resolved.href] = `throw new Error(${JSON.stringify(`Unsupported extension host module: ${resolved.pathname}`)});`;
                }
            }
            // Static imports/reexports exclude the quotes from their offsets;
            // dynamic imports include the entire literal (also for backticks).
            // Replace exactly one literal, including its original delimiters.
            const start = item.type === 'dynamic' ? item.start : item.start - 1;
            const end = item.type === 'dynamic' ? item.end : item.end + 1;
            rewritten = rewritten.slice(0, start) + JSON.stringify(resolved.href) + rewritten.slice(end);
        }
        modules[url] = rewritten;
        return url;
    };
    const entries: string[] = [];
    const scripts = manifest.js === undefined ? [] : Array.isArray(manifest.js) ? manifest.js : [manifest.js];
    for (const file of scripts) {
        if (typeof file !== 'string') throw new ApiError(400, 'validation', 'Invalid manifest js entry.');
        entries.push(visit(file));
    }
    if (manifest.entry && !entries.length && manifest.runtime !== 'headless' && manifest.runtime !== 'server-plugin') entries.push(visit(String(manifest.entry)));
    const cssFiles = manifest.css === undefined ? [] : Array.isArray(manifest.css) ? manifest.css : [manifest.css];
    const css = cssFiles.map((file: any) => { if (typeof file !== 'string') throw new ApiError(400, 'validation', 'Invalid manifest css entry.'); return load(file); });
    // HTML templates are data. Bounded discovery supports renderExtensionTemplateAsync with dynamic template names.
    let inspected = 0;
    const scan = (relative = '', depth = 0) => {
        const entries = fs.readdirSync(path.join(directory, relative), { withFileTypes: true });
        if (entries.length > 512) throw new ApiError(413, 'validation', 'Extension directory is too large.');
        for (const entry of entries) {
            if (++inspected > 2048) throw new ApiError(413, 'validation', 'Extension template inventory exceeds 2048 entries.');
            const file = relative ? `${relative}/${entry.name}` : entry.name;
            // Stop discovery at its depth bound. Extensions may ship unrelated
            // source trees below it; their presence must not reject usable UI.
            if (entry.isDirectory() && depth < 4 && !['node_modules', '.git'].includes(entry.name)) scan(file, depth + 1);
            else if (entry.isFile() && entry.name.endsWith('.html')) templates[file] = load(file);
        }
    };
    scan();
    const ui = typeof manifest.ui === 'string' ? manifest.ui : null;
    const html = ui ? templates[ui] ?? load(ui) : '';
    if (!entries.length && !html) throw new ApiError(422, 'unsupported', 'No browser settings UI is declared by this extension.');
    const libraries = {
        jquery: fs.readFileSync(require.resolve('jquery/dist/jquery.min.js'), 'utf8'),
        handlebars: fs.readFileSync(require.resolve('handlebars/dist/handlebars.min.js'), 'utf8'),
        purify: fs.readFileSync(require.resolve('dompurify/dist/purify.min.js'), 'utf8'),
        lodash: fs.readFileSync(require.resolve('lodash/lodash.min.js'), 'utf8'),
        moment: fs.readFileSync(require.resolve('moment/min/moment.min.js'), 'utf8'),
        bowser: fs.readFileSync(require.resolve('bowser/bundled.js'), 'utf8'),
    };
    return { extensionId: id, name, namespace, base, entries, modules, templates, css, html, libraries, activate: typeof manifest.activate === 'string' ? manifest.activate : null };
}
