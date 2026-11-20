import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { SETTINGS_FILE } from '../constants.js';
import { getConfigValue, isPathUnderParent, tryParse } from '../util.js';
import { serverDirectory } from '../server-directory.js';
import { ApiError, mergePatch, requireSafeId } from './contract.js';

const DEFAULT_SETTINGS_PATH = path.join(serverDirectory, 'default', 'content', 'settings.json');

/**
 * @typedef {object} HeadlessSession
 * @property {string} handle User handle
 * @property {import('../users.js').UserDirectoryList} directories User directories
 * @property {Record<string, any>} settings User settings
 * @property {Record<string, any>} extensionSettings Extension settings
 * @property {string} userName User persona name
 * @property {string} characterAvatar Character avatar filename
 */

/**
 * Checks whether API v1 is enabled.
 * @returns {boolean} Whether API v1 is enabled
 */
export function isApiV1Enabled() {
    return !!getConfigValue('api.v1.enabled', false, 'boolean') || process.env.SILLYTAVERN_API_V1_ENABLED === 'true';
}

/**
 * Reads user settings, falling back to the packaged defaults.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {Record<string, any>} Settings
 */
export function readSettings(directories) {
    const settingsPath = path.join(directories.root, SETTINGS_FILE);
    let stored = {};
    if (fs.existsSync(settingsPath)) {
        stored = tryParse(fs.readFileSync(settingsPath, 'utf8')) ?? {};
        if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
            stored = {};
        }
    }
    const defaults = tryParse(fs.readFileSync(DEFAULT_SETTINGS_PATH, 'utf8')) ?? {};
    const settings = { ...defaults, ...stored };
    if (!settings.oai_settings || typeof settings.oai_settings !== 'object') {
        settings.oai_settings = { ...(defaults.oai_settings ?? {}) };
    } else {
        settings.oai_settings = { ...(defaults.oai_settings ?? {}), ...settings.oai_settings };
    }
    if (!settings.power_user || typeof settings.power_user !== 'object') {
        settings.power_user = { ...(defaults.power_user ?? {}) };
    } else {
        settings.power_user = {
            ...(defaults.power_user ?? {}),
            ...settings.power_user,
            context: { ...(defaults.power_user?.context ?? {}), ...(settings.power_user.context ?? {}) },
            sysprompt: { ...(defaults.power_user?.sysprompt ?? {}), ...(settings.power_user.sysprompt ?? {}) },
        };
    }
    settings.world_info_settings = { ...(defaults.world_info_settings ?? {}), ...(settings.world_info_settings ?? {}) };
    settings.extension_settings = { ...(defaults.extension_settings ?? {}), ...(settings.extension_settings ?? {}) };
    return settings;
}

/**
 * Atomically writes user settings.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {Record<string, any>} settings Settings
 * @returns {void}
 */
export function writeSettings(directories, settings) {
    const settingsPath = path.join(directories.root, SETTINGS_FILE);
    writeFileAtomicSync(settingsPath, JSON.stringify(settings, null, 4), 'utf8');
}

/**
 * Applies a JSON Merge Patch to user settings.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {unknown} patch Merge patch
 * @returns {Record<string, any>} Updated settings
 */
export function patchSettings(directories, patch) {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw new ApiError(400, 'validation', 'Settings patch must be a JSON object.');
    }
    const settings = readSettings(directories);
    const updated = mergePatch(settings, patch);
    writeSettings(directories, updated);
    return updated;
}

/**
 * Builds a stateless headless session from the authenticated Express request.
 * @param {import('express').Request} request Express request
 * @returns {HeadlessSession} Headless session
 */
export function createSession(request) {
    if (!request.user?.directories?.root) {
        throw new ApiError(403, 'validation', 'Authenticated user data is unavailable.');
    }
    const settings = readSettings(request.user.directories);
    return {
        handle: request.user.profile?.handle ?? 'unknown',
        directories: request.user.directories,
        settings,
        extensionSettings: settings.extension_settings ?? {},
        userName: String(settings.username || 'User'),
        characterAvatar: '',
    };
}

/**
 * Reads a character card by its stable API v1 identifier.
 * @param {HeadlessSession} session Headless session
 * @param {string} characterId Character identifier
 * @returns {Promise<{id: string, avatar: string, name: string, data: Record<string, any>, raw: Record<string, any>, revision: string}>} Character
 */
export async function readCharacter(session, characterId) {
    const id = requireSafeId(characterId, 'characterId');
    const avatar = `${id}.png`;
    const filePath = path.join(session.directories.characters, avatar);
    if (!isPathUnderParent(session.directories.characters, filePath)) {
        throw new ApiError(400, 'validation', 'Character path is invalid.');
    }
    const { read } = await import('../character-card-parser.js');
    if (!fs.existsSync(filePath)) throw new ApiError(404, 'not_found', 'Character not found.');
    if (fs.lstatSync(filePath).isSymbolicLink() || !fs.statSync(filePath).isFile()) {
        throw new ApiError(400, 'validation', 'Character path is not a regular file.');
    }
    if (fs.statSync(filePath).size > 4 * 1024 * 1024) throw new ApiError(413, 'validation', 'Character image exceeds 4 MiB.');
    const bytes = fs.readFileSync(filePath);
    let rawText;
    try { rawText = read(bytes); } catch { throw new ApiError(422, 'validation', 'Character image does not contain a valid card.'); }
    const raw = tryParse(rawText);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ApiError(422, 'validation', 'Character card does not contain valid JSON.');
    }
    const data = normalizeCharacterData(raw);
    return {
        id,
        avatar,
        name: String(data.name || raw.name || id),
        data,
        raw,
        revision: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
}

/**
 * Normalizes Spec V1/V2/V3 character data into the fields used by the headless runtime.
 * @param {Record<string, any>} raw Raw card
 * @returns {Record<string, any>} Normalized card data
 */
export function normalizeCharacterData(raw) {
    const data = raw.data && typeof raw.data === 'object' ? { ...raw, ...raw.data } : { ...raw };
    data.name = String(data.name || raw.name || '');
    data.description = String(data.description || '');
    data.personality = String(data.personality || '');
    data.scenario = String(data.scenario || '');
    data.first_mes = String(data.first_mes || '');
    data.mes_example = String(data.mes_example || '');
    data.character_book = raw.data?.character_book ?? raw.character_book ?? null;
    return data;
}

/**
 * Lists character identifiers.
 * @param {HeadlessSession} session Headless session
 * @returns {Promise<Array<{id: string, avatar: string, name: string, chatCount: number, revision: string}>>} Characters
 */
export async function listCharacters(session) {
    const files = fs.existsSync(session.directories.characters)
        ? fs.readdirSync(session.directories.characters).filter(file => file.endsWith('.png'))
        : [];
    const characters = [];
    for (const file of files) {
        const id = path.parse(file).name;
        try {
            const character = await readCharacter(session, id);
            const chatsPath = path.join(session.directories.chats, id);
            const chatCount = fs.existsSync(chatsPath)
                ? fs.readdirSync(chatsPath).filter(name => name.endsWith('.jsonl')).length
                : 0;
            characters.push({ id, avatar: file, name: character.name, chatCount, revision: character.revision });
        } catch (error) {
            console.warn('[api-v1] Skipping unreadable character', id, error instanceof Error ? error.message : error);
        }
    }
    return characters;
}

/**
 * Lists chats for a character.
 * @param {HeadlessSession} session Headless session
 * @param {string} characterId Character identifier
 * @returns {Promise<Array<{id: string, fileName: string, size: number, modifiedAt: string}>>} Chats
 */
export async function listChats(session, characterId) {
    const id = requireSafeId(characterId, 'characterId');
    const chatsPath = path.join(session.directories.chats, id);
    if (!fs.existsSync(chatsPath)) {
        return [];
    }
    return fs.readdirSync(chatsPath, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(entry => {
            const stat = fs.statSync(path.join(chatsPath, entry.name));
            return {
                id: path.parse(entry.name).name,
                fileName: entry.name,
                size: stat.size,
                modifiedAt: stat.mtime.toISOString(),
            };
        });
}

/**
 * Resolves a chat file path from a character and chat identifier.
 * @param {HeadlessSession} session Headless session
 * @param {string} characterId Character identifier
 * @param {string} chatId Chat identifier
 * @returns {string} Chat file path
 */
export function resolveChatPath(session, characterId, chatId) {
    const character = requireSafeId(characterId, 'characterId');
    const chat = requireSafeId(chatId, 'chatId');
    const chatsPath = path.join(session.directories.chats, character);
    const filePath = path.join(chatsPath, `${chat}.jsonl`);
    if (!isPathUnderParent(chatsPath, filePath)) {
        throw new ApiError(400, 'validation', 'Chat path is invalid.');
    }
    return filePath;
}

/**
 * Creates a new ST chat for a character. Fails if the chat already exists.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {string} characterId Character identifier
 * @param {string} chatId Chat identifier
 * @param {string} [firstMessage] Optional greeting to seed
 * @param {string} [characterName] Display name for the greeting
 * @returns {{id: string, fileName: string, characterId: string}} Created chat
 */
export function createChat(session, characterId, chatId, firstMessage = '', characterName = characterId) {
    const filePath = resolveChatPath(session, characterId, chatId);
    if (fs.existsSync(filePath)) {
        throw new ApiError(409, 'conflict', 'Chat already exists.');
    }
    const message = firstMessage
        ? [createCharacterMessage(characterName, firstMessage)]
        : [];
    writeChat(filePath, [{ chat_metadata: {} }, ...message]);
    return { id: chatId, fileName: path.basename(filePath), characterId };
}

/**
 * Deletes a chat file.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {string} characterId Character identifier
 * @param {string} chatId Chat identifier
 * @returns {boolean} Whether the chat existed
 */
export function deleteChat(session, characterId, chatId) {
    const filePath = resolveChatPath(session, characterId, chatId);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
}

/**
 * Renames a chat file while preserving its contents.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {string} characterId Character identifier
 * @param {string} chatId Existing chat identifier
 * @param {string} newChatId New chat identifier
 * @returns {{id: string, fileName: string, characterId: string}} Renamed chat
 */
export function renameChat(session, characterId, chatId, newChatId) {
    const source = resolveChatPath(session, characterId, chatId);
    const targetId = requireSafeId(newChatId, 'newChatId');
    const target = resolveChatPath(session, characterId, targetId);
    if (!fs.existsSync(source)) {
        throw new ApiError(404, 'not_found', 'Chat not found.');
    }
    if (source !== target && fs.existsSync(target)) {
        throw new ApiError(409, 'conflict', 'A chat with that name already exists.');
    }
    if (source !== target) fs.renameSync(source, target);
    return { id: targetId, fileName: path.basename(target), characterId };
}

/**
 * Reads a page of chat messages with stable absolute indexes.
 * @param {string} filePath Chat file path
 * @param {object} [options] Paging options
 * @param {number} [options.limit] Maximum number of messages
 * @param {number} [options.before] Return messages with index < before
 * @param {number} [options.after] Return messages with index > after
 * @returns {{messages: Array<Record<string, any>>, total: number, hasMore: boolean, nextBefore: number|null}} Page
 */
export function readChatPage(filePath, { limit = 200, before = null, after = null } = {}) {
    const all = readChat(filePath);
    const boundedLimit = Math.min(500, Math.max(1, Number(limit) || 200));
    const parseAnchor = value => {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isInteger(number) && number >= 0 ? number : null;
    };
    const beforeIndex = parseAnchor(before);
    const afterIndex = parseAnchor(after);
    const indexed = all.map((message, index) => ({ ...message, index }));
    let page = indexed;
    if (beforeIndex !== null) page = page.filter(item => item.index < beforeIndex);
    if (afterIndex !== null) page = page.filter(item => item.index > afterIndex);
    // Before-paging keeps the NEWEST window; after-paging keeps the OLDEST window.
    const hasMore = page.length > boundedLimit;
    const window = hasMore
        ? (beforeIndex !== null ? page.slice(-boundedLimit) : page.slice(0, boundedLimit))
        : page;
    return {
        messages: window,
        total: indexed.length,
        hasMore,
        nextBefore: hasMore ? window[0].index : null,
    };
}

/**
 * Appends a message to a chat, or edits/deletes an existing one by index.
 * @param {string} filePath Chat file path
 * @param {object} operation Operation descriptor
 * @param {string} operation.action `append` | `edit` | `delete` | `swipe`
 * @param {Record<string, any>} [operation.message] Message for append/edit
 * @param {number} [operation.index] Target index for edit/delete
 * @param {number} [operation.swipeId] Reply alternative for swipe selection
 * @returns {number} New message index, or -1 for delete
 */
export function mutateChat(filePath, { action, message, index, swipeId }) {
    if (!fs.existsSync(filePath)) throw new ApiError(404, 'not_found', 'Chat not found.');
    const chat = readChat(filePath);
    if (action === 'append') {
        const entry = message && typeof message === 'object' && !Array.isArray(message) ? { ...message } : null;
        if (!entry) throw new ApiError(400, 'validation', 'A message object is required.');
        delete entry.index;
        chat.push(entry);
        writeChat(filePath, chat);
        return chat.length - 1;
    }
    if (!Number.isInteger(index) || index < 1 || index >= chat.length) {
        throw new ApiError(404, 'not_found', 'Message index is out of range.');
    }
    if (action === 'edit') {
        const entry = message && typeof message === 'object' && !Array.isArray(message) ? { ...message } : null;
        if (!entry) throw new ApiError(400, 'validation', 'A message object is required.');
        delete entry.index;
        chat[index] = { ...chat[index], ...entry };
        if (typeof entry.mes === 'string' && Array.isArray(chat[index].swipes)) {
            const selected = Number.isInteger(chat[index].swipe_id) ? chat[index].swipe_id : 0;
            if (selected >= 0 && selected < chat[index].swipes.length) chat[index].swipes[selected] = entry.mes;
        }
        writeChat(filePath, chat);
        return index;
    }
    if (action === 'swipe') {
        const entry = chat[index];
        if (entry.is_user || !Array.isArray(entry.swipes) || !Number.isInteger(swipeId) || swipeId < 0 || swipeId >= entry.swipes.length) {
            throw new ApiError(400, 'validation', 'A valid assistant swipe index is required.');
        }
        entry.swipe_id = swipeId;
        entry.mes = String(entry.swipes[swipeId]);
        entry.extra = { ...(entry.swipe_info?.[swipeId]?.extra ?? {}) };
        writeChat(filePath, chat);
        return index;
    }
    if (action === 'delete') {
        chat.splice(index, 1);
        writeChat(filePath, chat);
        return -1;
    }
    throw new ApiError(400, 'validation', `Unknown chat action "${action}".`);
}

/**
 * Reads a ST JSONL chat.
 * @param {string} filePath Chat file path
 * @returns {Array<Record<string, any>>} Chat messages
 */
export function readChat(filePath) {
    if (!fs.existsSync(filePath)) {
        return [];
    }
    return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => tryParse(line))
        .filter(message => message && typeof message === 'object' && !Array.isArray(message));
}

/**
 * Writes a ST JSONL chat atomically.
 * @param {string} filePath Chat file path
 * @param {Array<Record<string, any>>} chat Chat messages
 * @returns {void}
 */
export function writeChat(filePath, chat) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomicSync(filePath, chat.map(message => JSON.stringify(message)).join('\n'), 'utf8');
}

/**
 * Creates a new ST-compatible user message.
 * @param {HeadlessSession} session Headless session
 * @param {string} text Message text
 * @returns {Record<string, any>} User message
 */
export function createUserMessage(session, text) {
    return {
        name: session.userName,
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: String(text),
        swipe_id: 0,
        swipes: [String(text)],
        extra: {},
    };
}

/**
 * Creates a new ST-compatible character message.
 * @param {string} characterName Character name
 * @param {string} text Message text
 * @param {string} [reasoning] Reasoning text
 * @returns {Record<string, any>} Character message
 */
export function createCharacterMessage(characterName, text, reasoning = '') {
    return {
        name: characterName,
        is_user: false,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: String(text),
        swipe_id: 0,
        swipes: [String(text)],
        extra: reasoning ? { reasoning } : {},
    };
}
