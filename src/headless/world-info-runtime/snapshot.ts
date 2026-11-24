import fs from 'node:fs';
import path from 'node:path';
import { ApiError, requireSafeId } from '../contract.js';

/** Capture every selected file synchronously before worker evaluation can yield. */
export function snapshotWorldBooks(session: any, character: any, chat: any, characterId = '') {
    const config = session.settings.world_info_settings ?? {};
    const global = config.world_info?.globalSelect ?? [];
    const bindings = config.world_info?.charLore ?? [];
    if (!Array.isArray(global) || !Array.isArray(bindings)) throw new ApiError(422, 'validation', 'World Info selections must be arrays.');
    const extra = bindings.find(entry => entry?.name === characterId)?.extraBooks ?? [];
    if (!Array.isArray(extra)) throw new ApiError(422, 'validation', 'Character lorebook selections must be an array.');
    const names = [...global, ...extra, chat[0]?.chat_metadata?.world_info, session.settings.power_user?.persona_description_lorebook, character.extensions?.world].filter(Boolean);
    const books = Object.create(null);
    let bytes = 0;
    for (const name of new Set(names)) {
        requireSafeId(name, 'World Info name');
        if (typeof session.directories?.worlds !== 'string') throw new ApiError(422, 'storage', 'World Info directory is unavailable.');
        const file = path.join(session.directories.worlds, `${name}.json`);
        let raw, descriptor;
        try {
            descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
            const stat = fs.fstatSync(descriptor);
            if (!stat.isFile()) throw new ApiError(422, 'storage', 'Selected World Info is not a regular file.');
            if (stat.size > 4_194_304 || bytes + stat.size > 33_554_432) throw new ApiError(422, 'validation', 'Selected World Info exceeds its 4 MiB per-book or 32 MiB total limit.');
            const buffer = Buffer.alloc(stat.size + 1);
            let offset = 0;
            while (offset < buffer.length) {
                const size = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
                if (!size) break;
                offset += size;
            }
            if (offset !== stat.size) throw new ApiError(422, 'storage', 'Selected World Info changed during snapshot. Inspect it before another attempt.');
            raw = buffer.subarray(0, offset);
            bytes += raw.length;
        } catch (error: any) {
            if (error instanceof ApiError) throw error;
            if (error.code === 'ENOENT' && name === character.extensions?.world && character.character_book) continue;
            throw new ApiError(422, 'storage', `Selected World Info book "${name}" is missing or unreadable.`);
        } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
        try {
            const book = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
            if (!book?.entries || typeof book.entries !== 'object' || Array.isArray(book.entries)) throw new Error('Invalid book');
            books[name] = book;
        } catch { throw new ApiError(422, 'storage', `Selected World Info book "${name}" contains invalid JSON/UTF-8 or entries.`); }
    }
    return books;
}
