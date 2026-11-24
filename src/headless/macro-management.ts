import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS_FILE } from '../constants.js';
import { ApiError, requireObject } from './contract.js';
import { assertChatIdle } from './generation-store.js';
import { readSettings, resolveChatPath, writeChat, writeSettings } from './session.js';

// Keep the complete document (including revision/envelope) within the native
// client's 8 MiB success bound and the companion's authenticated JSON bound.
const MAX_VARIABLE_JSON = 7_340_032;
function variables(value: any, stored = false) {
    const candidate = value == null && stored ? {} : value;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new ApiError(stored ? 422 : 400, 'validation', 'Macro variables must be a JSON object.');
    const encoded = JSON.stringify(candidate);
    if (Buffer.byteLength(encoded) > MAX_VARIABLE_JSON) throw new ApiError(422, 'validation', 'Macro variable document exceeds the 7 MiB native editor limit. Existing state has not been changed.');
    return JSON.parse(encoded);
}
function document(value: any, experimental: any = undefined) {
    const result = { variables: variables(value, true), ...(experimental === undefined ? {} : { experimental }) };
    return { ...result, revision: crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}
function input(body: any, current: any, global: any) {
    requireObject(body, 'macro variable edit');
    const keys = ['expectedRevision', 'variables', ...(global ? ['experimental'] : [])];
    if (Object.keys(body).some(key => !keys.includes(key))) throw new ApiError(400, 'validation', 'Unknown macro variable edit field.');
    if (typeof body.expectedRevision !== 'string' || body.expectedRevision !== current.revision) throw new ApiError(409, 'conflict', 'Macro variables or engine changed. Reload before saving; your draft has not been applied.');
    if (global && typeof body.experimental !== 'boolean') throw new ApiError(400, 'validation', 'experimental must be a boolean.');
    return variables(body.variables);
}

export function readGlobalMacros(session: any) {
    const settings = editableSettings(session);
    validateStoredContainer(settings.extension_settings?.variables);
    return document(settings.extension_settings?.variables?.global, settings.power_user?.experimental_macro_engine !== false);
}
export function saveGlobalMacros(session: any, body: any) {
    const settings = editableSettings(session);
    validateStoredContainer(settings.extension_settings?.variables);
    const current = document(settings.extension_settings?.variables?.global, settings.power_user?.experimental_macro_engine !== false);
    const edited = input(body, current, true);
    settings.extension_settings ??= {};
    settings.extension_settings.variables = { ...(settings.extension_settings.variables ?? {}), global: edited };
    settings.power_user = { ...(settings.power_user ?? {}), experimental_macro_engine: body.experimental };
    writeSettings(session.directories, settings);
    return document(edited, body.experimental);
}
export function localChat(session: any, characterId: any, chatId: any) {
    const file = resolveChatPath(session, characterId, chatId);
    if (!fs.existsSync(file)) throw new ApiError(404, 'not_found', 'Chat does not exist.');
    let chat;
    try {
        // A metadata edit must not silently discard an invalid transcript line
        // through the older permissive history reader.
        const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
        chat = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
        if (chat.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid row');
    } catch { throw new ApiError(422, 'storage', 'Chat contains unreadable transcript data. Existing state has not been changed.'); }
    if (chat.length === 0) throw new ApiError(404, 'not_found', 'Chat does not exist.');
    if (!chat[0] || typeof chat[0] !== 'object' || typeof chat[0].mes === 'string') throw new ApiError(422, 'storage', 'Chat metadata header is missing. Inspect the transcript before editing variables.');
    if (chat[0].chat_metadata != null && (typeof chat[0].chat_metadata !== 'object' || Array.isArray(chat[0].chat_metadata))) throw new ApiError(422, 'storage', 'Chat metadata is invalid. Existing state has not been changed.');
    return { file, chat };
}
function validateStoredContainer(value: any) {
    if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new ApiError(422, 'storage', 'Stored macro variable container is invalid. Existing state has not been changed.');
}
export function editableSettings(session: any) {
    const file = path.join(session.directories.root, SETTINGS_FILE);
    if (fs.existsSync(file)) {
        try {
            const stored = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)));
            if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Invalid settings');
            for (const key of ['oai_settings', 'power_user', 'extension_settings', 'world_info_settings']) {
                if (stored[key] != null && (typeof stored[key] !== 'object' || Array.isArray(stored[key]))) throw new Error('Invalid settings container');
            }
        } catch { throw new ApiError(422, 'storage', 'Stored settings are unreadable. Existing state has not been changed.'); }
    }
    return readSettings(session.directories);
}
export function readLocalMacros(session: any, characterId: any, chatId: any) {
    const { chat } = localChat(session, characterId, chatId);
    return document(chat[0].chat_metadata?.variables);
}
export function saveLocalMacros(session: any, characterId: any, chatId: any, body: any) {
    assertChatIdle(session.handle, characterId, chatId, session.directories);
    const { file, chat } = localChat(session, characterId, chatId);
    const edited = input(body, document(chat[0].chat_metadata?.variables), false);
    chat[0].chat_metadata = { ...(chat[0].chat_metadata ?? {}), variables: edited };
    writeChat(file, chat);
    return document(edited);
}
