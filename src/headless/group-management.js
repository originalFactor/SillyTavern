import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { ApiError, requireSafeId } from './contract.js';
import { assertCharacterIdle, assertChatIdle } from './generation-store.js';
import { listCharacters, pageChat, readCharacter, writeChat } from './session.js';
import { persistMacroEffects } from './macros.js';
import { runNativeText } from './prompt.js';

const MAX_GROUP_BYTES = 512 * 1024;
const MAX_MEMBERS = 32;
const GROUP_ACTIVATION_STRATEGIES = new Set([0, 1, 2, 3]);
const GROUP_GENERATION_MODES = new Set([0, 1, 2]);

function groupPath(session, groupId) {
    const id = requireSafeId(groupId, 'groupId');
    const file = path.join(session.directories.groups, `${id}.json`);
    if (!file.startsWith(`${session.directories.groups}${path.sep}`)) throw new ApiError(400, 'validation', 'Group path is invalid.');
    return { id, file };
}

function chatPath(session, chatId) {
    const id = requireSafeId(chatId, 'groupChatId');
    const file = path.join(session.directories.groupChats, `${id}.jsonl`);
    if (!file.startsWith(`${session.directories.groupChats}${path.sep}`)) throw new ApiError(400, 'validation', 'Group chat path is invalid.');
    return { id, file };
}

function revision(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validateGroup(group) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new ApiError(400, 'validation', 'A group object is required.');
    if (typeof group.name !== 'string' || !group.name.trim() || group.name.length > 200) throw new ApiError(400, 'validation', 'Group name must contain 1–200 characters.');
    if (!Array.isArray(group.members) || group.members.length === 0 || group.members.length > MAX_MEMBERS) throw new ApiError(400, 'validation', 'A group must contain 1–32 members.');
    // ST stores group members as character avatar filenames. Keep that exact
    // identifier in the descriptor because the filename is also the lookup
    // key used by the browser group runtime.
    const members = group.members.map(member => requireSafeId(String(member), 'memberId'));
    if (new Set(members).size !== members.length) throw new ApiError(400, 'validation', 'Group members must be unique.');
    const disabled = Array.isArray(group.disabled_members) ? group.disabled_members.map(member => requireSafeId(String(member), 'disabledMemberId')) : [];
    if (disabled.some(member => !members.includes(member))) throw new ApiError(400, 'validation', 'Disabled members must belong to the group.');
    const activation = Number(group.activation_strategy ?? 0);
    const mode = Number(group.generation_mode ?? 0);
    if (!Number.isInteger(activation) || !GROUP_ACTIVATION_STRATEGIES.has(activation)) throw new ApiError(400, 'validation', 'Unknown group activation strategy.');
    if (!Number.isInteger(mode) || !GROUP_GENERATION_MODES.has(mode)) throw new ApiError(400, 'validation', 'Unknown group generation mode.');
    const chats = Array.isArray(group.chats) ? group.chats.map(chat => requireSafeId(String(chat), 'groupChatId')) : [];
    if (new Set(chats).size !== chats.length || chats.length > 256) throw new ApiError(400, 'validation', 'Group chat identifiers are invalid.');
    return {
        ...group,
        members,
        disabled_members: [...new Set(disabled)],
        activation_strategy: activation,
        generation_mode: mode,
        chats,
        chat_id: group.chat_id == null ? (chats[0] ?? null) : group.chat_id === '' ? '' : requireSafeId(String(group.chat_id), 'chatId'),
        allow_self_responses: Boolean(group.allow_self_responses),
        auto_mode_delay: Math.min(3600, Math.max(0, Number(group.auto_mode_delay ?? 5) || 0)),
        generation_mode_join_prefix: String(group.generation_mode_join_prefix ?? '').slice(0, 4096),
        generation_mode_join_suffix: String(group.generation_mode_join_suffix ?? '').slice(0, 4096),
    };
}

async function readGroup(session, groupId) {
    const { id, file } = groupPath(session, groupId);
    if (!fs.existsSync(file)) throw new ApiError(404, 'not_found', 'Group not found.');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_GROUP_BYTES) throw new ApiError(422, 'validation', 'Group file is invalid or oversized.');
    const bytes = fs.readFileSync(file);
    let group;
    try { group = JSON.parse(bytes.toString('utf8')); } catch { throw new ApiError(422, 'validation', 'Group file is not valid JSON.'); }
    if (group && typeof group === 'object' && !Array.isArray(group) && group.chat_id === undefined) {
        const characters = await listCharacters(session);
        const members = Array.isArray(group.members) ? group.members : [];
        const avatars = members.map(name => characters.find(character => character.name === name)?.avatar);
        if (avatars.some(avatar => !avatar)) throw new ApiError(422, 'validation', 'A legacy group member could not be matched to a character.');
        group.members = [...new Set(avatars)];
        group.chat_id = id;
        group.chats = [id];
    }
    return { id, group: validateGroup(group), revision: revision(bytes) };
}

export async function listGroups(session) {
    fs.mkdirSync(session.directories.groups, { recursive: true });
    return Promise.all(fs.readdirSync(session.directories.groups, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(async entry => {
            try {
                const item = await readGroup(session, path.parse(entry.name).name);
                return { id: item.id, revision: item.revision, group: item.group };
            } catch (error) {
                if (error instanceof ApiError) return { id: path.parse(entry.name).name, invalid: true, detail: error.message };
                throw error;
            }
        }));
}

export async function getGroup(session, groupId) {
    const item = await readGroup(session, groupId);
    return { id: item.id, revision: item.revision, group: item.group };
}

/** Load the member cards needed for a group prompt in group order. */
export async function loadGroupCharacters(session, group) {
    const characters = [];
    for (const avatar of group.members) {
        if (!avatar.endsWith('.png')) throw new ApiError(422, 'unsupported', 'Group member avatar format is not supported.');
        let card;
        try {
            card = await readCharacter(session, avatar.slice(0, -4));
        } catch (error) {
            if (error instanceof ApiError && error.status === 404) continue;
            throw error;
        }
        characters.push({ ...card.data, name: card.name, avatar: card.avatar, data: card.data });
    }
    return characters;
}

export function saveGroup(session, { groupId, group, expectedRevision, create = true }) {
    const { id, file } = groupPath(session, groupId);
    const validated = validateGroup(group);
    const exists = fs.existsSync(file);
    if (create && exists) throw new ApiError(409, 'conflict', 'Group ID already exists.');
    if (!create && !exists) throw new ApiError(404, 'not_found', 'Group not found.');
    const previous = exists ? fs.readFileSync(file) : null;
    if (!create && (!expectedRevision || revision(previous) !== expectedRevision)) throw new ApiError(409, 'conflict', 'Group changed since it was opened. Reload before saving.');
    if (!create) assertCharacterIdle(session.handle, id, session.directories, 'group');
    const bytes = Buffer.from(JSON.stringify({ ...validated, id }, null, 4));
    if (bytes.length > MAX_GROUP_BYTES) throw new ApiError(413, 'validation', 'Group file exceeds 512 KiB.');
    fs.mkdirSync(session.directories.groups, { recursive: true });
    writeFileAtomicSync(file, bytes);
    return { id, revision: revision(bytes), group: validated };
}

export async function deleteGroup(session, groupId, expectedRevision, deleteChats = false) {
    const item = await readGroup(session, groupId);
    const current = fs.readFileSync(groupPath(session, item.id).file);
    if (!expectedRevision || item.revision !== expectedRevision || revision(current) !== expectedRevision) throw new ApiError(409, 'conflict', 'Group changed since it was opened. Reload before deleting.');
    assertCharacterIdle(session.handle, item.id, session.directories, 'group');
    const active = item.group.chats.filter(chatId => fs.existsSync(chatPath(session, chatId).file));
    if (active.length && !deleteChats) throw new ApiError(409, 'confirmation_required', 'Group chats exist. Set deleteChats=true to remove them explicitly.', { details: { chatIds: active } });
    if (active.length) {
        for (const entry of fs.readdirSync(session.directories.groups, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === `${item.id}.json`) continue;
            let other;
            try {
                const file = path.join(session.directories.groups, entry.name);
                if (fs.statSync(file).size > MAX_GROUP_BYTES) throw new Error('Oversized group');
                other = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)));
                if (!other || typeof other !== 'object' || Array.isArray(other) || (other.chats != null && (!Array.isArray(other.chats) || other.chats.some(chat => typeof chat !== 'string')))) throw new Error('Invalid group');
            } catch {
                throw new ApiError(409, 'conflict', 'Cannot verify whether another group references these chats. Inspect the group files before deleting.');
            }
            const otherChats = other.chat_id === undefined ? [path.parse(entry.name).name] : (other.chats ?? []);
            const shared = active.filter(chatId => otherChats.includes(chatId));
            if (shared.length) throw new ApiError(409, 'conflict', 'Another group references these chats. Remove the shared references before deleting them.', { details: { chatIds: shared } });
        }
    }
    for (const chatId of active) {
        assertChatIdle(session.handle, item.id, chatId, session.directories, 'group');
    }
    for (const chatId of active) {
        fs.unlinkSync(chatPath(session, chatId).file);
    }
    fs.unlinkSync(groupPath(session, item.id).file);
    return { deleted: true, id: item.id, deletedChats: active };
}

export async function listGroupChats(session, groupId) {
    const item = await readGroup(session, groupId);
    return item.group.chats.map(chatId => {
        const { file } = chatPath(session, chatId);
        if (!fs.existsSync(file)) return { id: chatId, missing: true };
        const stat = fs.statSync(file);
        return { id: chatId, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    });
}

/** Delete one group chat after checking the group revision and shared references. */
export async function deleteGroupChat(session, groupId, chatId, expectedRevision) {
    const item = await readGroup(session, groupId);
    const { id, file } = chatPath(session, chatId);
    if (!item.group.chats.includes(id)) throw new ApiError(404, 'not_found', 'Group chat is not attached to this group.');
    if (!expectedRevision || expectedRevision !== item.revision) throw new ApiError(409, 'conflict', 'Group changed since it was opened. Reload before deleting a chat.');
    assertCharacterIdle(session.handle, item.id, session.directories, 'group');
    assertChatIdle(session.handle, item.id, id, session.directories, 'group');
    for (const entry of fs.readdirSync(session.directories.groups, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === `${item.id}.json`) continue;
        let other;
        try {
            const otherFile = path.join(session.directories.groups, entry.name);
            if (fs.statSync(otherFile).size > MAX_GROUP_BYTES) throw new Error('Oversized group');
            other = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(otherFile)));
            if (!other || typeof other !== 'object' || Array.isArray(other) || (other.chats != null && (!Array.isArray(other.chats) || other.chats.some(chat => typeof chat !== 'string')))) throw new Error('Invalid group');
        } catch {
            throw new ApiError(409, 'conflict', 'Cannot verify whether another group references this chat. Inspect the group files before deleting.');
        }
        const chats = other.chat_id === undefined ? [path.parse(entry.name).name] : (other.chats ?? []);
        if (chats.includes(id)) throw new ApiError(409, 'conflict', 'Another group references this chat. Remove the shared reference before deleting.');
    }
    const chats = item.group.chats.filter(chat => chat !== id);
    const updated = saveGroup(session, {
        groupId: item.id,
        group: { ...item.group, chats, chat_id: item.group.chat_id === id ? (chats[0] ?? '') : item.group.chat_id },
        expectedRevision,
        create: false,
    });
    try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (error) {
        saveGroup(session, { groupId: item.id, group: item.group, expectedRevision: updated.revision, create: false });
        throw error;
    }
    return updated;
}

export async function createGroupChat(session, groupId, chatId, expectedRevision) {
    const item = await readGroup(session, groupId);
    const { id, file } = chatPath(session, chatId);
    const groupFile = groupPath(session, item.id).file;
    if (!expectedRevision || item.revision !== expectedRevision || revision(fs.readFileSync(groupFile)) !== expectedRevision) {
        throw new ApiError(409, 'conflict', 'Group changed since it was opened. Reload before creating a chat.');
    }
    if (fs.existsSync(file)) throw new ApiError(409, 'conflict', 'Group chat ID already exists.');
    assertChatIdle(session.handle, item.id, id, session.directories, 'group');
    const attached = item.group.chats.includes(id);
    if (!attached && item.group.chats.length >= 256) throw new ApiError(400, 'validation', 'Group has too many chats.');
    fs.mkdirSync(session.directories.groupChats, { recursive: true });
    let descriptor;
    try {
        descriptor = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
        if (error.code === 'EEXIST') throw new ApiError(409, 'conflict', 'Group chat ID already exists.');
        throw error;
    }
    try {
        try {
            fs.writeFileSync(descriptor, JSON.stringify({ chat_metadata: {}, user_name: 'unused', character_name: 'unused' }) + '\n');
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        return attached ? { id: item.id, revision: item.revision, group: item.group } : saveGroup(session, {
            groupId: item.id, group: { ...item.group, chats: [...item.group.chats, id], chat_id: id }, expectedRevision, create: false,
        });
    } catch (error) {
        fs.unlinkSync(file);
        throw error;
    }
}

export async function readGroupChat(session, groupId, chatId, paging = {}) {
    const item = await readGroup(session, groupId);
    if (!item.group.chats.includes(chatId)) throw new ApiError(404, 'not_found', 'Group chat is not attached to this group.');
    const { file } = chatPath(session, chatId);
    if (!fs.existsSync(file)) throw new ApiError(404, 'not_found', 'Group chat not found.');
    return { groupId: item.id, chatId, ...pageChat(parseGroupChat(file), paging) };
}

/** Project a page for display without modifying stored messages or variables. */
export async function renderGroupChat(session, groupId, chatId, options = {}) {
    const item = await readGroup(session, groupId);
    const { id, file } = chatPath(session, chatId);
    if (!item.group.chats.includes(id) || !fs.existsSync(file)) throw new ApiError(404, 'not_found', 'Group chat not found.');
    const original = parseGroupChat(file);
    const headerless = !original.length || !Object.hasOwn(original[0], 'chat_metadata');
    const chat = headerless ? [{ chat_metadata: {} }, ...original] : original;
    const page = pageChat(original, options);
    const characters = await loadGroupCharacters(session, item.group);
    const views = [], warnings = [];
    for (const message of page.messages) {
        if (typeof message.mes !== 'string') continue;
        let characterIndex = characters.findIndex(character => character.avatar === message.original_avatar);
        if (characterIndex < 0 && !message.is_user) characterIndex = characters.findIndex(character => character.name === message.name);
        if (characterIndex < 0 && message.is_user) characterIndex = 0;
        const character = characters[characterIndex];
        if (!character) throw new ApiError(422, 'unsupported', 'The message character is unavailable for display.');
        const result = await runNativeText(session, character.data, chat, {
            mode: 'display', characterId: character.avatar.slice(0, -4), chatId: id,
            nativeContext: options.nativeContext ?? {}, groupContext: { group: { ...item.group, id: item.id }, characters, characterIndex },
            messages: [{ ...message, index: message.index + (headerless ? 1 : 0) }],
        });
        const view = result.messages[0];
        views.push({ index: message.index, display: view.display, displayReasoning: view.displayReasoning });
        warnings.push(...result.warnings);
        if (result.discardedVariableEffects) warnings.push('Display regex proposed variable changes; transcript reads never save these effects.');
    }
    return { groupId: item.id, chatId: id, ...page, views, warnings: [...new Set(warnings)] };
}

export async function selectGroupSwipe(session, groupId, chatId, index, swipeId, expectedMessage) {
    const item = await readGroup(session, groupId);
    const { id, file } = chatPath(session, chatId);
    if (!item.group.chats.includes(id) || !fs.existsSync(file)) throw new ApiError(404, 'not_found', 'Group chat not found.');
    assertChatIdle(session.handle, item.id, id, session.directories, 'group');
    const chat = parseGroupChat(file);
    const entry = Number.isInteger(index) && index >= 0 ? chat[index] : null;
    if (!entry || entry.is_user || typeof entry.mes !== 'string' || !Array.isArray(entry.swipes) ||
        !Number.isInteger(swipeId) || swipeId < 0 || swipeId >= entry.swipes.length || typeof entry.swipes[swipeId] !== 'string') {
        throw new ApiError(400, 'validation', 'A valid assistant message and swipe index are required.');
    }
    if (expectedMessage !== undefined) {
        if (!expectedMessage || typeof expectedMessage !== 'object' || Array.isArray(expectedMessage)) throw new ApiError(400, 'validation', 'Expected message must be an object.');
        const expected = { ...expectedMessage };
        delete expected.index;
        if (!isDeepStrictEqual(entry, expected)) throw new ApiError(409, 'conflict', 'Message changed. Reload before switching replies.');
    }
    entry.swipe_id = swipeId;
    entry.mes = entry.swipes[swipeId];
    entry.extra = { ...(entry.swipe_info?.[swipeId]?.extra ?? {}) };
    writeChat(file, chat);
    return { groupId: item.id, chatId: id, index, swipeId };
}

export async function deleteGroupMessage(session, groupId, chatId, index, expectedMessage) {
    const item = await readGroup(session, groupId);
    const { id, file } = chatPath(session, chatId);
    if (!item.group.chats.includes(id) || !fs.existsSync(file)) throw new ApiError(404, 'not_found', 'Group chat not found.');
    assertChatIdle(session.handle, item.id, id, session.directories, 'group');
    const chat = parseGroupChat(file);
    const entry = Number.isInteger(index) && index >= 0 ? chat[index] : null;
    if (!entry || typeof entry.mes !== 'string') throw new ApiError(404, 'not_found', 'Message not found.');
    if (!expectedMessage || typeof expectedMessage !== 'object' || Array.isArray(expectedMessage)) throw new ApiError(400, 'validation', 'Expected message is required.');
    const expected = { ...expectedMessage };
    delete expected.index;
    if (!isDeepStrictEqual(entry, expected)) throw new ApiError(409, 'conflict', 'Message changed. Reload before deleting.');
    chat.splice(index, 1);
    writeChat(file, chat);
    return { groupId: item.id, chatId: id, index };
}

export async function editGroupMessage(session, groupId, chatId, index, expectedMessage, text, nativeContext = {}) {
    if (typeof text !== 'string') throw new ApiError(400, 'validation', 'Message text is required.');
    const item = await readGroup(session, groupId);
    const { id, file } = chatPath(session, chatId);
    if (!item.group.chats.includes(id) || !fs.existsSync(file)) throw new ApiError(404, 'not_found', 'Group chat not found.');
    assertChatIdle(session.handle, item.id, id, session.directories, 'group');
    const original = parseGroupChat(file);
    const entry = Number.isInteger(index) && index >= 0 ? original[index] : null;
    if (!entry || typeof entry.mes !== 'string') throw new ApiError(404, 'not_found', 'Message not found.');
    if (!expectedMessage || typeof expectedMessage !== 'object' || Array.isArray(expectedMessage)) throw new ApiError(400, 'validation', 'Expected message is required.');
    const expected = { ...expectedMessage };
    delete expected.index;
    if (!isDeepStrictEqual(entry, expected)) throw new ApiError(409, 'conflict', 'Message changed. Reload before editing.');
    const characters = await loadGroupCharacters(session, item.group);
    let characterIndex = characters.findIndex(character => character.avatar === entry.original_avatar);
    if (characterIndex < 0 && !entry.is_user) characterIndex = characters.findIndex(character => character.name === entry.name);
    if (characterIndex < 0 && entry.is_user) characterIndex = 0;
    if (!characters[characterIndex]) throw new ApiError(422, 'unsupported', 'The message character is unavailable.');
    const character = characters[characterIndex];
    const headerless = !original.length || !Object.hasOwn(original[0], 'chat_metadata');
    const chat = headerless ? [{ chat_metadata: {} }, ...structuredClone(original)] : structuredClone(original);
    const messageIndex = index + (headerless ? 1 : 0);
    const result = await runNativeText(session, character.data, chat, {
        mode: 'edit', characterId: character.avatar.slice(0, -4), chatId: id, nativeContext,
        groupContext: { group: { ...item.group, id: item.id }, characters, characterIndex },
        message: { ...entry, mes: text },
    });
    const current = await readGroup(session, groupId);
    if (!current.group.chats.includes(id) || !fs.existsSync(file)) throw new ApiError(409, 'conflict', 'Group chat changed during editing.');
    assertChatIdle(session.handle, item.id, id, session.directories, 'group');
    if (current.revision !== item.revision || !isDeepStrictEqual(parseGroupChat(file), original)) throw new ApiError(409, 'conflict', 'Group or transcript changed during editing. Reload before saving.');
    try {
        persistMacroEffects(session, file, chat, result.macroEffects);
        const edited = chat[messageIndex];
        edited.mes = result.text;
        if (Array.isArray(edited.swipes)) {
            const selected = Number.isInteger(edited.swipe_id) ? edited.swipe_id : 0;
            if (selected >= 0 && selected < edited.swipes.length) edited.swipes[selected] = result.text;
        }
        if (result.warnings.regexWarnings.length || result.warnings.macroWarnings.length || Object.hasOwn(edited.extra ?? {}, 'native_regex_warnings') || Object.hasOwn(edited.extra ?? {}, 'native_macro_warnings')) {
            edited.extra = { ...edited.extra, native_regex_warnings: result.warnings.regexWarnings, native_macro_warnings: result.warnings.macroWarnings };
        }
        writeChat(file, headerless && !result.macroEffects?.localDirty ? chat.slice(1) : chat);
    } catch {
        throw new ApiError(500, 'unknown', 'Message publication could not be confirmed. Inspect the transcript and variables before saving again.');
    }
    return { groupId: item.id, chatId: id, index: headerless && result.macroEffects?.localDirty ? index + 1 : index };
}

function parseGroupChat(file) {
    let chat;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
        chat = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
        if (chat.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid row');
    } catch { throw new ApiError(422, 'storage', 'Group chat contains unreadable transcript data.'); }
    if (chat.length && Object.hasOwn(chat[0], 'chat_metadata') && (!chat[0].chat_metadata || typeof chat[0].chat_metadata !== 'object' || Array.isArray(chat[0].chat_metadata))) {
        throw new ApiError(422, 'storage', 'Group chat metadata header is invalid.');
    }
    return chat;
}

export async function resolveGroupChat(session, groupId, chatId) {
    const item = await readGroup(session, groupId);
    const { id, file } = chatPath(session, chatId);
    if (!item.group.chats.includes(id) || !fs.existsSync(file)) throw new ApiError(404, 'not_found', 'Group chat not found.');
    const chat = parseGroupChat(file);
    // Older group chats can contain messages without a metadata header.
    // Match the browser loader by supplying empty metadata in memory only.
    if (!chat.length || !Object.hasOwn(chat[0], 'chat_metadata')) {
        chat.unshift({ chat_metadata: {} });
    }
    return { group: { ...item.group, id: item.id }, file, chat };
}
