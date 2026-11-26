#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = path.join(root, 'vite.config.js');
const entry = path.join(root, 'dist/src/headless-server.js');
let vite;
let child;
let debounce;
let rebuilding = false;
let rebuildQueued = false;
let stopping = false;

function launch() {
    child = spawn(process.execPath, [entry], {
        cwd: root,
        env: process.env,
        stdio: 'inherit',
    });
    child.on('exit', code => {
        if (!stopping && code && code !== 0) console.error(`[dev] backend exited with code ${code}`);
    });
}

async function stopBackend() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const oldChild = child;
    child = undefined;
    await new Promise(resolve => {
        const timeout = setTimeout(() => oldChild.kill('SIGKILL'), 5000);
        oldChild.once('exit', () => {
            clearTimeout(timeout);
            resolve();
        });
        oldChild.kill('SIGTERM');
    });
}

async function rebuild() {
    if (stopping) return;
    if (rebuilding) {
        rebuildQueued = true;
        return;
    }
    rebuilding = true;
    do {
        rebuildQueued = false;
        try {
            await stopBackend();
            await build({ configFile, mode: 'development' });
            if (!stopping) {
                console.log('[dev] build updated; restarting backend');
                launch();
            }
        } catch (error) {
            console.error('[dev] rebuild failed; backend remains stopped', error);
        }
    } while (rebuildQueued && !stopping);
    rebuilding = false;
}

async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearTimeout(debounce);
    await stopBackend();
    await vite?.close();
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

try {
    await build({ configFile, mode: 'development' });
    if (!stopping) {
        vite = await createServer({
            configFile,
            appType: 'custom',
            server: { middlewareMode: true, hmr: false },
        });
    }
    if (stopping) {
        await vite?.close();
    } else {
        vite.watcher.on('all', (event, file) => {
            const relative = path.relative(root, file);
            const watchedRoots = ['src', 'compat-source', 'default'];
            if (!watchedRoots.some(directory => relative === directory || relative.startsWith(`${directory}${path.sep}`)) && relative !== 'server.js') return;
            clearTimeout(debounce);
            debounce = setTimeout(() => void rebuild(), 120);
        });
        launch();
        console.log('[dev] Vite build watcher active; backend restarts after source changes');
    }
} catch (error) {
    await shutdown();
    throw error;
}
