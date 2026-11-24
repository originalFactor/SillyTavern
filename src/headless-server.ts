#!/usr/bin/env node
/** Standard standalone entry point for the headless fork. */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataRoot = path.resolve(process.env.SILLYTAVERN_DATA_ROOT ?? path.join(serverDirectory, 'data'));
const port = process.env.SILLYTAVERN_PORT ?? '8000';
const token = crypto.randomBytes(32).toString('hex');
process.argv = [process.argv[0], path.join(serverDirectory, 'dist/src/headless-companion.js'), '--dataRoot', dataRoot, '--port', port, '--token', token];
await import('./headless-companion.js');
