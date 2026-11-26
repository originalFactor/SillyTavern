import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, version as viteVersion } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageNames = new Set(Object.keys({ ...packageJson.dependencies, ...packageJson.optionalDependencies }));
const builtinNames = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

function sourceFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(fullPath);
        return /\.(?:ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [fullPath] : [];
    });
}

const appEntries = Object.fromEntries([
    ...sourceFiles(path.join(root, 'src')),
].map(file => [path.relative(root, file).replace(/\.(?:ts|js)$/, ''), file]));

function isExternal(id) {
    if (builtinNames.has(id)) return true;
    const name = id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0];
    return packageNames.has(name);
}

function upstreamLibConfig() {
    const cacheHash = crypto.createHash('sha256')
        .update(JSON.stringify([packageJson.version, viteVersion]))
        .digest('hex').slice(0, 16);
    const cacheRoot = process.env.DATA_ROOT
        ? path.resolve(process.env.DATA_ROOT, '_vite')
        : path.join(root, 'dist', '_vite');
    const outDir = path.join(cacheRoot, cacheHash, 'output');
    fs.mkdirSync(outDir, { recursive: true });
    return {
        root,
        configFile: false,
        build: {
            outDir,
            emptyOutDir: false,
            minify: false,
            lib: {
                entry: path.join(root, 'compat-source/upstream/lib.js'),
                formats: ['es'],
                fileName: () => 'lib.js',
            },
            rollupOptions: { output: { format: 'es' } },
        },
    };
}

export default defineConfig(({ command, mode }) => {
    if (mode === 'upstream-lib') return upstreamLibConfig();

    // TypeScript sources use NodeNext `.js` import specifiers. Remove stale
    // compiler output before Rollup resolves those imports so it cannot pick
    // up yesterday's dist files as source modules.
    if (command === 'build') fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });

    return {
        root,
        appType: 'custom',
        build: {
            outDir: 'dist',
            emptyOutDir: true,
            ssr: true,
            target: 'node20',
            minify: false,
            sourcemap: false,
            rollupOptions: {
                input: appEntries,
                external: isExternal,
                preserveEntrySignatures: 'strict',
                output: {
                    format: 'es',
                    preserveModules: true,
                    preserveModulesRoot: root,
                    entryFileNames: '[name].js',
                    chunkFileNames: '[name].js',
                },
            },
        },
        server: {
            host: '127.0.0.1',
            strictPort: true,
            hmr: false,
            watch: { ignored: ['**/dist/**', '**/node_modules/**', '**/data/**'] },
        },
        optimizeDeps: { noDiscovery: true, include: [] },
    };
});
