import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { ApiError, requireSafeId } from './contract.js';
import { assertCharacterIdle, assertChatIdle } from './generation-store.js';
import { listCharacters, readCharacter, readChatPage } from './session.js';

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
    const updated = attached ? { id: item.id, revision: item.revision, group: item.group } : saveGroup(session, {
        groupId: item.id, group: { ...item.group, chats: [...item.group.chats, id], chat_id: id }, expectedRevision, create: false,
    });
    writeFileAtomicSync(file, JSON.stringify({ chat_metadata: {}, user_name: 'unused', character_name: 'unused' }) + '\n');
    return updated;
}

export async function readGroupChat(session, groupId, chatId, paging = {}) {
    const item = await readGroup(session, groupId);
    if (!item.group.chats.includes(chatId)) throw new ApiError(404, 'not_found', 'Group chat is not attached to this group.');
    const { file } = chatPath(session, chatId);
    if (!fs.existsSync(file)) throw new ApiError(404, 'not_found', 'Group chat not found.');
    return { groupId: item.id, chatId, ...readChatPage(file, paging) };
}

export async function resolveGroupChat(session, groupId, chatId) {
    const item = await readGroup(session, groupId);
    const { id, file } = chatPath(session, chatId);
    if (!item.group.chats.includes(id) || !fs.existsSync(file)) throw new ApiError(404, 'not_found', 'Group chat not found.');
    let chat;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
        chat = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
        if (chat.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid row');
    } catch { throw new ApiError(422, 'storage', 'Group chat contains unreadable transcript data.'); }
    // Older group chats can contain messages without a metadata header.
    // Match the browser loader by supplying empty metadata in memory only.
    if (!chat.length || !Object.hasOwn(chat[0], 'chat_metadata')) {
        chat.unshift({ chat_metadata: {} });
    } else if (!chat[0].chat_metadata || typeof chat[0].chat_metadata !== 'object' || Array.isArray(chat[0].chat_metadata)) {
        throw new ApiError(422, 'storage', 'Group chat metadata header is invalid.');
    }
    return { group: { ...item.group, id: item.id }, file, chat };
}
