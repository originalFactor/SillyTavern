import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { ApiError, requireSafeId } from './contract.js';
import { assertChatIdle } from './generation-store.js';
import { readChatPage } from './session.js';

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
    const members = group.members.map(member => requireSafeId(String(member).replace(/\.png$/i, ''), 'memberId'));
    if (new Set(members).size !== members.length) throw new ApiError(400, 'validation', 'Group members must be unique.');
    const disabled = Array.isArray(group.disabled_members) ? group.disabled_members.map(member => requireSafeId(String(member).replace(/\.png$/i, ''), 'disabledMemberId')) : [];
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
        chat_id: group.chat_id == null ? (chats[0] ?? null) : requireSafeId(String(group.chat_id), 'chatId'),
        allow_self_responses: Boolean(group.allow_self_responses),
        auto_mode_delay: Math.min(3600, Math.max(0, Number(group.auto_mode_delay ?? 5) || 0)),
        generation_mode_join_prefix: String(group.generation_mode_join_prefix ?? '').slice(0, 4096),
        generation_mode_join_suffix: String(group.generation_mode_join_suffix ?? '').slice(0, 4096),
    };
}

function readGroup(session, groupId) {
    const { id, file } = groupPath(session, groupId);
    if (!fs.existsSync(file)) throw new ApiError(404, 'not_found', 'Group not found.');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_GROUP_BYTES) throw new ApiError(422, 'validation', 'Group file is invalid or oversized.');
    const bytes = fs.readFileSync(file);
    let group;
    try { group = JSON.parse(bytes.toString('utf8')); } catch { throw new ApiError(422, 'validation', 'Group file is not valid JSON.'); }
    return { id, group: validateGroup(group), revision: revision(bytes) };
}

export function listGroups(session) {
    fs.mkdirSync(session.directories.groups, { recursive: true });
    return fs.readdirSync(session.directories.groups, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => {
            try {
                const item = readGroup(session, path.parse(entry.name).name);
                return { id: item.id, revision: item.revision, group: item.group };
            } catch (error) {
                if (error instanceof ApiError) return { id: path.parse(entry.name).name, invalid: true, detail: error.message };
                throw error;
            }
        });
}

export function getGroup(session, groupId) {
    const item = readGroup(session, groupId);
    return { id: item.id, revision: item.revision, group: item.group };
}

export function saveGroup(session, { groupId, group, expectedRevision, create = true }) {
    const { id, file } = groupPath(session, groupId);
    const validated = validateGroup(group);
    const exists = fs.existsSync(file);
    if (create && exists) throw new ApiError(409, 'conflict', 'Group ID already exists.');
    if (!create && !exists) throw new ApiError(404, 'not_found', 'Group not found.');
    const previous = exists ? fs.readFileSync(file) : null;
    if (!create && (!expectedRevision || revision(previous) !== expectedRevision)) throw new ApiError(409, 'conflict', 'Group changed since it was opened. Reload before saving.');
    const bytes = Buffer.from(JSON.stringify({ ...validated, id }, null, 4));
    if (bytes.length > MAX_GROUP_BYTES) throw new ApiError(413, 'validation', 'Group file exceeds 512 KiB.');
    fs.mkdirSync(session.directories.groups, { recursive: true });
    writeFileAtomicSync(file, bytes);
    return { id, revision: revision(bytes), group: validated };
}

export function deleteGroup(session, groupId, expectedRevision, deleteChats = false) {
    const item = readGroup(session, groupId);
    if (!expectedRevision || item.revision !== expectedRevision) throw new ApiError(409, 'conflict', 'Group changed since it was opened. Reload before deleting.');
    const active = item.group.chats.filter(chatId => fs.existsSync(chatPath(session, chatId).file));
    if (active.length && !deleteChats) throw new ApiError(409, 'confirmation_required', 'Group chats exist. Set deleteChats=true to remove them explicitly.', { details: { chatIds: active } });
    for (const chatId of active) {
        assertChatIdle(session.handle, item.id, chatId, session.directories);
        fs.unlinkSync(chatPath(session, chatId).file);
    }
    fs.unlinkSync(groupPath(session, item.id).file);
    return { deleted: true, id: item.id, deletedChats: active };
}

export function listGroupChats(session, groupId) {
    const item = readGroup(session, groupId);
    return item.group.chats.map(chatId => {
        const { file } = chatPath(session, chatId);
        if (!fs.existsSync(file)) return { id: chatId, missing: true };
        const stat = fs.statSync(file);
        return { id: chatId, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    });
}

export function readGroupChat(session, groupId, chatId, paging = {}) {
    const item = readGroup(session, groupId);
    if (!item.group.chats.includes(chatId)) throw new ApiError(404, 'not_found', 'Group chat is not attached to this group.');
    const { file } = chatPath(session, chatId);
    if (!fs.existsSync(file)) throw new ApiError(404, 'not_found', 'Group chat not found.');
    return { groupId: item.id, chatId, ...readChatPage(file, paging) };
}
