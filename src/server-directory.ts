import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Runtime modules execute from dist/src after the TypeScript build.
export const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
