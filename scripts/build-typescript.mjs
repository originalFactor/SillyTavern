import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
const compiler = path.join(root, 'node_modules/typescript/bin/tsc');
const result = spawnSync(process.execPath, [compiler, '-p', path.join(root, 'tsconfig.json')], {
    cwd: root,
    stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
