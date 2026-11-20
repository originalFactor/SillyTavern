#!/usr/bin/env node
/**
 * Builds the minimal SillyTavern companion bundle consumed by the Messenger
 * Runtime APK. Run from the SillyTavern repository root:
 *
 *   node scripts/build-companion-bundle.mjs --out <dir>
 *
 * The output is copied verbatim to the companion's private files dir by
 * `StCompanionRuntime.extractBundle()`. It contains ONLY the server-side
 * modules reachable from `src/headless-companion.js` (resolved by walking the
 * static + dynamic import graph), plus the packaged defaults. No browser SPA,
 * no `public/`, no dev dependencies, no user data, no credentials.
 *
 * `node_modules` is NOT copied: the companion installs the pinned production
 * dependencies inside the extracted bundle on first start. This script never
 * calls a package manager itself, so the Gradle side can invoke it without
 * adding a JS toolchain to the Android build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Files with no JS import edge but required at runtime. */
const EXTRA_FILES = [
    'package.json',
    'pnpm-lock.yaml',
    'default/content/settings.json',
    'default/content/default_Seraphina.png',
    'default/config.yaml',
    // Loaded via `new URL('./plugin-worker.js', import.meta.url)`, not an import
    // specifier, so the graph walker cannot discover it.
    'src/headless/plugin-worker.js',
];
/** Non-JS data directories referenced at runtime. */
const DATA_DIRECTORIES = [
    'src/tokenizers',
];

const seen = new Set();
const external = new Set();

/**
 * Extracts static and dynamic import specifiers from JS source.
 * @param {string} source File contents
 * @returns {string[]} Specifiers
 */
function specifiers(source) {
    const result = [];
    const patterns = [
        /\bfrom\s*['"]([^'"]+)['"]/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /\bimport\s*['"]([^'"]+)['"]/g,
    ];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) result.push(match[1]);
    }
    return result.filter(spec => {
        // Reject string-literal false positives (template bodies, code snippets)
        // and anything that is not a plausible package or relative path.
        if (spec.length > 200 || /[\s"'`\\]/.test(spec)) return false;
        return /^(\.{1,2}\/[^\s]*|\/[^\s]*|@?[a-zA-Z0-9][\w.@/-]*)$/.test(spec);
    });
}

/**
 * Resolves a relative specifier to an existing local file.
 * @param {string} fromFile Importer path (absolute)
 * @param {string} spec Import specifier
 * @returns {string|null} Absolute file path or null
 */
function resolveLocal(fromFile, spec) {
    const base = path.resolve(path.dirname(fromFile), spec);
    const candidates = [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js'), path.join(base, 'index.mjs')];
    return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

/**
 * Walks the import graph and records every reachable local file.
 * @param {string} file Absolute file path
 * @returns {void}
 */
function walk(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const spec of specifiers(source)) {
        if (!spec.startsWith('.') && !spec.startsWith('/')) {
            if (!spec.startsWith('node:')) {
                external.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
            }
            continue;
        }
        const target = spec.startsWith('/') ? path.join(ROOT, spec) : resolveLocal(file, spec);
        if (target && target.startsWith(ROOT) && fs.existsSync(target)) walk(target);
    }
}

/**
 * Copies a path (file or directory) into the bundle.
 * @param {string} relative Relative path from the ST root
 * @param {string} out Output root
 * @returns {void}
 */
function copyEntry(relative, out) {
    const source = path.join(ROOT, relative);
    if (!fs.existsSync(source)) return;
    const target = path.join(out, relative);
    if (fs.statSync(source).isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
        for (const entry of fs.readdirSync(source)) copyEntry(path.join(relative, entry), out);
    } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
    }
}

/**
 * Counts all regular files in a directory tree.
 * @param {string} dir Directory
 * @returns {number} File count
 */
function countFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
        const full = path.join(dir, entry.name);
        return total + (entry.isDirectory() ? countFiles(full) : 1);
    }, 0);
}

/**
 * Writes the bundle manifest, verified by the companion at extraction time.
 * @param {string} out Output root
 * @param {number} fileCount Number of copied files
 * @returns {void}
 */
function writeManifest(out, fileCount) {
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    fs.writeFileSync(path.join(out, 'companion-bundle.json'), JSON.stringify({
        schema: 1,
        service: 'messenger-sillytavern',
        stVersion: version,
        entry: 'src/headless-companion.js',
        fileCount,
        externalPackages: [...external].sort(),
        needsNodeModules: true,
        nodeEngine: '>=20',
    }, null, 4), 'utf8');
}

function main() {
    const argv = process.argv.slice(2);
    const outIndex = argv.indexOf('--out');
    if (outIndex === -1 || !argv[outIndex + 1]) throw new Error('--out <dir> is required');
    const out = path.resolve(argv[outIndex + 1]);

    walk(path.join(ROOT, 'src/headless-companion.js'));
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    for (const file of seen) copyEntry(path.relative(ROOT, file), out);
    for (const file of EXTRA_FILES) copyEntry(file, out);
    for (const directory of DATA_DIRECTORIES) copyEntry(directory, out);
    fs.copyFileSync(path.join(ROOT, 'public/img/user-default.png'), path.join(out, 'default/content/companion-user.png'));
    const total = countFiles(out);
    writeManifest(out, total);
    console.log(JSON.stringify({ type: 'bundle_ready', out, files: total, modules: seen.size, externalPackages: [...external].sort() }));
}

main();
