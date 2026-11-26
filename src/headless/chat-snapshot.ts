import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from './contract.js';
import { resolveChatPath } from './session.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES = 10000;

/** A complete, read-only projection of one bounded ST JSONL file, never a page. */
export function readTranscriptSnapshot(root: string, file: string, allowHeaderless = false) {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new ApiError(400, 'validation', 'Chat snapshot path is invalid.');
    let descriptor: number | undefined;
    let bytes: Buffer;
    try {
        let directory = root;
        for (const part of ['.', ...relative.split(path.sep).slice(0, -1)]) {
            directory = path.join(directory, part);
            const info = fs.lstatSync(directory);
            if (info.isSymbolicLink() || !info.isDirectory()) throw new ApiError(422, 'storage', 'Chat snapshot directory is not a regular directory.');
        }
        descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const before = fs.fstatSync(descriptor, { bigint: true });
        if (!before.isFile()) throw new ApiError(422, 'storage', 'Chat snapshot is not a regular file.');
        if (before.size > BigInt(MAX_BYTES)) throw new ApiError(413, 'validation', 'Chat snapshot exceeds 8 MiB.');
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let length = 0;
        while (length < buffer.length) {
            const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
            if (!count) break;
            length += count;
        }
        const after = fs.fstatSync(descriptor, { bigint: true });
        const current = fs.lstatSync(file, { bigint: true });
        if (length !== Number(before.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => (before as any)[key] !== (after as any)[key] || (after as any)[key] !== (current as any)[key]) || current.isSymbolicLink()) throw new ApiError(409, 'conflict', 'Chat changed while reading its snapshot. Reload before continuing.');
        bytes = buffer.subarray(0, length);
    } catch (error: any) {
        if (error instanceof ApiError) throw error;
        if (error?.code === 'ENOENT') throw new ApiError(404, 'not_found', 'Chat not found.');
        throw new ApiError(422, 'storage', 'Chat snapshot could not be read safely.');
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
    let rows: Record<string, any>[];
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const lines = text.split('\n').filter(line => line.trim());
        if (lines.length > MAX_MESSAGES + 1) throw new ApiError(413, 'validation', 'Chat snapshot exceeds 10000 messages.');
        rows = lines.map(line => JSON.parse(line));
        if (rows.some(row => !object(row))) throw Error('Invalid row');
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(422, 'storage', 'Chat snapshot contains invalid UTF-8 or JSONL rows.');
    }
    const headerPresent = !!rows.length && Object.hasOwn(rows[0], 'chat_metadata');
    if (headerPresent && (!object(rows[0].chat_metadata) || Object.hasOwn(rows[0], 'mes'))) throw new ApiError(422, 'storage', 'Chat snapshot metadata header is invalid.');
    if (!headerPresent && !allowHeaderless) throw new ApiError(422, 'storage', 'Chat snapshot metadata header is missing.');
    const messages = headerPresent ? rows.slice(1) : rows;
    if (messages.length > MAX_MESSAGES) throw new ApiError(413, 'validation', 'Chat snapshot exceeds 10000 messages.');
    if (messages.some(row => Object.hasOwn(row, 'chat_metadata'))) throw new ApiError(422, 'storage', 'Chat snapshot contains an unexpected metadata row.');
    return { revision: crypto.createHash('sha256').update(bytes).digest('hex'), headerPresent, chatMetadata: headerPresent ? rows[0].chat_metadata : {}, messages };
}

export function readCharacterChatSnapshot(session: any, characterId: string, chatId: string) {
    const file = resolveChatPath(session, characterId, chatId);
    return { characterId, chatId, ...readTranscriptSnapshot(session.directories.chats, file) };
}
