import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sync as writeAtomic } from 'write-file-atomic';
import { ApiError, requireObject, requireSafeId } from './contract.js';
import { editableSettings, localChat } from './macro-management.js';
import { assertChatIdle } from './generation-store.js';
import { normalizeCharacterData, writeChat, writeSettings } from './session.js';
import { read as readCard } from '../character-card-parser.js';
import { acquireGenerationOwner } from './generation-owner.js';

const MAX_BOOK = 4_194_304;
const hash = (value: any) => crypto.createHash('sha256').update(value).digest('hex');
const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
function nameOf(name: any) {
    requireSafeId(name, 'World Info name');
    if (name !== name.trim() || name.endsWith('.')) throw new ApiError(400, 'validation', 'World Info name must be trimmed and must not end with a dot.');
    return name;
}
function own() { if (globalThis.DATA_ROOT) acquireGenerationOwner(globalThis.DATA_ROOT); }
function folder(session: any) {
    const dir = session.directories.worlds;
    if (typeof dir !== 'string') throw new ApiError(422, 'storage', 'World Info storage is unavailable.');
    if (fs.existsSync(dir) && (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory())) throw new ApiError(422, 'storage', 'World Info directory must be a regular directory.');
    return dir;
}
function boundedFile(file: any, max: any) {
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > max) throw new Error('Not a bounded file');
        const bytes = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null); if (!n) break; offset += n; }
        if (offset !== stat.size) throw new Error('Changed length');
        return bytes.subarray(0, offset);
    } catch (error: any) {
        if (error.code === 'ENOENT') throw new ApiError(404, 'not_found', 'World Info file not found.');
        throw new ApiError(422, 'storage', 'World Info or reference data is unreadable, unsafe, changed during reading or exceeds its size limit.');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function parse(bytes: any) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); }
function validateBook(book: any) {
    requireObject(book, 'World Info book');
    if (!object(book.entries) || Object.keys(book.entries).length > 20000) throw new ApiError(400, 'validation', 'World Info entries must be an object containing at most 20000 entries. Import native SillyTavern JSON; foreign formats require conversion first.');
    for (const entry of Object.values(book.entries) as Array<Record<string, any>>) {
        if (!object(entry) || typeof entry.content !== 'string' || ['key', 'keysecondary'].some(key => entry[key] !== undefined && (!Array.isArray(entry[key]) || entry[key].some((value: any) => typeof value !== 'string')))) throw new ApiError(400, 'validation', 'Each World Info entry needs string content and string arrays for any primary/secondary keys.');
    }
    if (Buffer.byteLength(JSON.stringify(book)) > MAX_BOOK) throw new ApiError(413, 'validation', 'World Info book exceeds 4 MiB.');
    return book;
}
export function getWorldBook(session: any, name: any) {
    const file = path.join(folder(session), `${nameOf(name)}.json`);
    const bytes = boundedFile(file, MAX_BOOK);
    let book;
    try { book = validateBook(parse(bytes)); } catch { throw new ApiError(422, 'storage', 'World Info book contains invalid JSON/UTF-8 or entries. Existing data has not been changed.'); }
    return { name, revision: hash(bytes), book };
}
export function listWorldBooks(session: any) {
    const dir = folder(session);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter(file => file.name.endsWith('.json')) : [];
    if (files.length > 512) throw new ApiError(422, 'validation', 'World Info catalog exceeds the 512-book native management limit.');
    const books = [], warnings = [];
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
        const name = file.name.slice(0, -5);
        // Catalog inspection lists bounded regular files; opening a book
        // validates its contents without reading the entire catalog into memory.
        try {
            nameOf(name);
            const stat = fs.lstatSync(path.join(dir, file.name));
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BOOK) throw new Error('Unsafe file');
            books.push({ name, bytes: stat.size });
        } catch { warnings.push({ name, message: 'Book cannot be managed safely. Inspect its filename, type and size.' }); }
    }
    return { books, warnings };
}
export function saveWorldBook(session: any, name: any, body: any) {
    requireObject(body, 'World Info edit');
    if (Object.keys(body).some(key => !['expectedRevision', 'book'].includes(key))) throw new ApiError(400, 'validation', 'Unknown World Info edit field.');
    const dir = folder(session), file = path.join(dir, `${nameOf(name)}.json`);
    let current = null;
    try { current = getWorldBook(session, name); } catch (error: any) { if (error.status !== 404) throw error; }
    if ((body.expectedRevision ?? null) !== (current?.revision ?? null)) throw new ApiError(409, 'conflict', 'World Info book changed or already exists. Reload before saving; your draft has not been applied.');
    const book = validateBook(body.book);
    if (!current) {
        const catalog = listWorldBooks(session);
        if (catalog.books.length + catalog.warnings.length >= 512) throw new ApiError(422, 'validation', 'World Info catalog is full.');
    }
    own(); fs.mkdirSync(dir, { recursive: true });
    writeAtomic(file, JSON.stringify(book), 'utf8');
    return getWorldBook(session, name);
}
export function exportWorldBook(session: any, name: any) {
    const value = getWorldBook(session, name);
    return { fileName: `${name}.json`, mimeType: 'application/json', dataBase64: Buffer.from(JSON.stringify(value.book)).toString('base64') };
}

const bools = ['world_info_include_names', 'world_info_recursive', 'world_info_case_sensitive', 'world_info_match_whole_words', 'world_info_use_group_scoring'];
const ranges: Record<string, [number, number]> = { world_info_depth: [0, 1000], world_info_min_activations: [0, 20000], world_info_min_activations_depth_max: [0, 1000], world_info_character_strategy: [0, 2], world_info_max_recursion_steps: [0, 2000] };
function settingsDoc(settings: any) {
    const value = settings.world_info_settings ?? {};
    if (!object(value)) throw new ApiError(422, 'storage', 'Stored World Info settings are invalid.');
    const cleaned = { ...value };
    delete cleaned.world_info_budget;
    delete cleaned.world_info_budget_cap;
    delete cleaned.world_info_overflow_alert;
    return { settings: cleaned, revision: hash(JSON.stringify(value)) };
}
export function getWorldSettings(session: any) { return settingsDoc(editableSettings(session)); }
function names(value: any) {
    if (!Array.isArray(value) || value.length > 512 || new Set(value).size !== value.length) throw new ApiError(400, 'validation', 'Book selections must be an array of at most 512 unique names.');
    value.forEach(nameOf); return value;
}
export function saveWorldSettings(session: any, body: any) {
    requireObject(body, 'World Info settings edit');
    if (Object.keys(body).some(key => !['expectedRevision', 'settings'].includes(key))) throw new ApiError(400, 'validation', 'Unknown World Info settings edit field.');
    const settings = editableSettings(session);
    if (body.expectedRevision !== settingsDoc(settings).revision) throw new ApiError(409, 'conflict', 'World Info settings changed. Reload before saving.');
    const value = { ...requireObject(body.settings, 'World Info settings') };
    delete value.world_info_budget;
    delete value.world_info_budget_cap;
    delete value.world_info_overflow_alert;
    if (Buffer.byteLength(JSON.stringify(value)) > 1_048_576) throw new ApiError(413, 'validation', 'World Info settings exceed 1 MiB.');
    for (const key of bools) if (key in value && typeof value[key] !== 'boolean') throw new ApiError(400, 'validation', `${key} must be boolean.`);
    for (const [key, [min, max]] of Object.entries(ranges) as Array<[string, [number, number]]>) {
        const current = value[key];
        if (key in value && (typeof current !== 'number' || !Number.isInteger(current) || current < min || current > max)) throw new ApiError(400, 'validation', `${key} must be an integer in ${min}..${max}.`);
    }
    const info: Record<string, any> = value.world_info ?? {};
    requireObject(info, 'World Info bindings');
    const selected = [...names(info.globalSelect ?? [])];
    if (!Array.isArray(info.charLore ?? []) || (info.charLore?.length ?? 0) > 512) throw new ApiError(400, 'validation', 'Character bindings must be an array of at most 512 records.');
    const characters = new Set();
    for (const row of info.charLore ?? []) {
        requireSafeId(row?.name, 'Character binding');
        if (characters.has(row.name)) throw new ApiError(400, 'validation', 'Duplicate character binding.');
        characters.add(row.name); selected.push(...names(row.extraBooks));
    }
    for (const name of new Set(selected)) getWorldBook(session, name);
    settings.world_info_settings = value;
    own(); writeSettings(session.directories, settings);
    return settingsDoc(settings);
}
function chatDoc(chat: any) {
    const name = chat[0].chat_metadata?.world_info ?? '';
    if (typeof name !== 'string') throw new ApiError(422, 'storage', 'Chat World Info binding is invalid.');
    return { name, revision: hash(JSON.stringify(name)) };
}
export function getChatWorldBook(session: any, characterId: any, chatId: any) { return chatDoc(localChat(session, characterId, chatId).chat); }
export function saveChatWorldBook(session: any, characterId: any, chatId: any, body: any) {
    requireObject(body, 'Chat World Info edit');
    if (Object.keys(body).some(key => !['expectedRevision', 'name'].includes(key))) throw new ApiError(400, 'validation', 'Unknown chat World Info edit field.');
    assertChatIdle(session.handle, characterId, chatId, session.directories);
    const { file, chat } = localChat(session, characterId, chatId);
    if (body.expectedRevision !== chatDoc(chat).revision) throw new ApiError(409, 'conflict', 'Chat World Info binding changed. Reload before saving.');
    if (typeof body.name !== 'string') throw new ApiError(400, 'validation', 'Chat World Info name must be a string; empty clears the binding.');
    if (body.name) getWorldBook(session, body.name);
    chat[0].chat_metadata = { ...(chat[0].chat_metadata ?? {}), world_info: body.name };
    own(); writeChat(file, chat);
    return chatDoc(chat);
}

// Never silently detach references across cards/settings/transcripts. Deletion
// refuses unsafe or oversized reference inventories rather than guessing.
export function deleteWorldBook(session: any, name: any, revision: any) {
    const current = getWorldBook(session, name);
    if (current.revision !== revision) throw new ApiError(409, 'conflict', 'World Info book changed. Reload before deleting.');
    const settings = editableSettings(session), info: Record<string, any> = settings.world_info_settings?.world_info ?? {}, p: Record<string, any> = settings.power_user ?? {};
    if (!object(info) || !Array.isArray(info.globalSelect ?? []) || !Array.isArray(info.charLore ?? []) || (info.charLore ?? []).some((row: any) => !object(row) || !Array.isArray(row.extraBooks)) || !object(p.persona_descriptions ?? {})) throw new ApiError(422, 'storage', 'World Info reference settings are malformed. Existing book has not been deleted.');
    const used = () => { throw new ApiError(409, 'conflict', 'World Info book is still bound. Remove its global, character, Persona and chat bindings before deleting.'); };
    if ((info.globalSelect ?? []).includes(name) || (info.charLore ?? []).some((row: any) => row.extraBooks?.includes(name)) || p.persona_description_lorebook === name || (Object.values(p.persona_descriptions ?? {}) as Array<Record<string, any>>).some(row => row?.lorebook === name)) used();
    let total = 0, count = 0;
    function entries(dir: any) {
        if (!dir || !fs.existsSync(dir)) return [];
        if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()) throw new ApiError(422, 'storage', 'Reference directory is unsafe. Existing book has not been deleted.');
        const result = fs.readdirSync(dir, { withFileTypes: true }); count += result.length;
        if (count > 10000) throw new ApiError(422, 'storage', 'Reference inventory exceeds its safety limit. Existing book has not been deleted.');
        return result;
    }
    function bytes(file: any, max: any) {
        const value = boundedFile(file, max); total += value.length;
        if (total > 67_108_864) throw new ApiError(422, 'storage', 'Reference inventory exceeds 64 MiB. Existing book has not been deleted.');
        return value;
    }
    try {
        for (const entry of entries(session.directories.characters).filter(entry => entry.name.endsWith('.png'))) {
            const card = normalizeCharacterData(JSON.parse(readCard(bytes(path.join(session.directories.characters, entry.name), MAX_BOOK))));
            if (card.extensions?.world === name) used();
        }
        const chatFiles = [];
        for (const dir of entries(session.directories.chats)) {
            const parent = path.join(session.directories.chats, dir.name);
            if (!dir.isDirectory()) { if (dir.isSymbolicLink()) throw new Error('Unsafe reference'); continue; }
            chatFiles.push(...entries(parent).filter(entry => entry.name.endsWith('.jsonl')).map(entry => path.join(parent, entry.name)));
        }
        chatFiles.push(...entries(session.directories.groupChats).filter(entry => entry.name.endsWith('.jsonl')).map(entry => path.join(session.directories.groupChats, entry.name)));
        for (const file of chatFiles) {
            // Bounded complete reads also ensure malformed headers cannot be
            // mistaken for an absent reference. Larger histories fail closed.
            const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes(file, 8_388_608));
            const header = JSON.parse(raw.split('\n', 1)[0]);
            if (!object(header) || typeof header.mes === 'string' || !object(header.chat_metadata ?? {})) throw new Error('Invalid header');
            if (header.chat_metadata?.world_info === name) used();
        }
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(422, 'storage', 'Reference data is unreadable. Existing book has not been deleted.'); }
    own(); fs.unlinkSync(path.join(folder(session), `${nameOf(name)}.json`));
    return { deleted: true, name };
}
