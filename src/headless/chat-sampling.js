import crypto from 'node:crypto';
import { ApiError, requireObject } from './contract.js';
import { assertChatIdle } from './generation-store.js';
import { localChat } from './macro-management.js';
import { writeChat } from './session.js';

const FIELD = 'messenger_sampling';
const NUMERIC_FIELDS = new Set(['temperature', 'topP', 'frequencyPenalty', 'presencePenalty']);

function validate(value, stored = false) {
    if (value == null && stored) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(stored ? 422 : 400, 'validation', 'Chat sampling must be an object.');
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (NUMERIC_FIELDS.has(key) && typeof entry === 'number' && Number.isFinite(entry)) result[key] = entry;
        else if (key === 'maxTokens' && Number.isSafeInteger(entry) && entry > 0) result[key] = entry;
        else if (key === 'model' && typeof entry === 'string' && entry.trim() && entry.length <= 512) result[key] = entry;
        else if (key === 'stop' && Array.isArray(entry) && entry.length <= 4 && entry.every(item => typeof item === 'string' && item.length <= 1024)) result[key] = [...entry];
        else throw new ApiError(stored ? 422 : 400, 'validation', 'Chat sampling contains an invalid field or value.');
    }
    return result;
}

function document(value) {
    const overrides = validate(value, true);
    const canonical = Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)));
    return { overrides: canonical, revision: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
}

export function chatSampling(chat) {
    return document(chat[0]?.chat_metadata?.[FIELD]).overrides;
}

export function readChatSampling(session, characterId, chatId) {
    const { chat } = localChat(session, characterId, chatId);
    return document(chat[0].chat_metadata?.[FIELD]);
}

export function saveChatSampling(session, characterId, chatId, body) {
    assertChatIdle(session.handle, characterId, chatId, session.directories);
    const { file, chat } = localChat(session, characterId, chatId);
    requireObject(body, 'chat sampling edit');
    if (Object.keys(body).some(key => !['expectedRevision', 'overrides'].includes(key))) throw new ApiError(400, 'validation', 'Unknown chat sampling field.');
    if (body.expectedRevision !== document(chat[0].chat_metadata?.[FIELD]).revision) throw new ApiError(409, 'conflict', 'Chat sampling changed. Reload before saving.');
    const overrides = validate(body.overrides);
    chat[0].chat_metadata = { ...(chat[0].chat_metadata ?? {}), [FIELD]: overrides };
    writeChat(file, chat);
    return document(overrides);
}
