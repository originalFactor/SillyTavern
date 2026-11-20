import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { ApiError, getUserKey } from './contract.js';

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const TERMINAL_TTL_MS = 5 * 60 * 1000;
const JOURNAL_DIRECTORY = 'api-v1-generations';
const MAX_RESTORED_RECORDS = 100;
const MAX_PLUGIN_EVENTS = 64;

/**
 * @typedef {object} GenerationEvent
 * @property {number} seq Event sequence
 * @property {string} type Event type
 * @property {Record<string, any>} data Event data
 */

/**
 * @typedef {object} GenerationRecord
 * @property {string} requestId Request identifier
 * @property {string} userKey Hashed user key
 * @property {string} clientRequestId Client idempotency key
 * @property {string} characterId Character identifier
 * @property {string} chatId Chat identifier
 * @property {string} type Generation type
 * @property {string} status Generation status
 * @property {number} seq Last event sequence
 * @property {string} text Accumulated output
 * @property {string} reasoning Accumulated reasoning
 * @property {GenerationEvent[]} events Bounded live event journal
 * @property {Set<import('express').Response>} subscribers SSE subscribers
 * @property {AbortController} controller Provider abort controller
 * @property {NodeJS.Timeout} heartbeat Heartbeat timer
 * @property {number} createdAt Creation timestamp
 * @property {number} [finishedAt] Terminal timestamp
 * @property {{code: string, message: string, retryable: boolean}|null} error Terminal error
 * @property {string|null} cancelOutcome Cancellation outcome
 * @property {boolean} committed Whether the chat was committed
 * @property {Record<string, any>} [snapshot] Final snapshot
 */

/** @type {Map<string, GenerationRecord>} */
const generations = new Map();
/** @type {Map<string, string>} */
const idempotency = new Map();
/** @type {Set<string>} Directories whose journals have already been restored */
const restoredDirectories = new Set();
/** @type {Map<string, Promise<void>>} Per-chat serialization of detached generations */
const chatLocks = new Map();

/**
 * Reject transcript mutations while a detached generation may still commit.
 * Checks admission records as well as the lock, including accepted work that
 * has not yet acquired its chat lock. Call and mutate without an intervening
 * await so another request cannot be admitted between the check and write.
 * @param {string} handle User handle
 * @param {string} characterId Character identifier
 * @param {string} chatId Chat identifier
 * @returns {void}
 */
export function assertChatIdle(handle, characterId, chatId) {
    const userKey = getUserKey(handle);
    for (const record of generations.values()) {
        if (record.userKey === userKey && record.characterId === characterId && record.chatId === chatId && !isTerminal(record.status)) {
            throw new ApiError(409, 'conflict', 'This chat has an active generation. Stop it and wait for completion before changing history.');
        }
    }
}

/**
 * Reject character mutation/deletion while any of its turns can still commit.
 * @param {string} handle User handle
 * @param {string} characterId Character identifier
 * @returns {void}
 */
export function assertCharacterIdle(handle, characterId) {
    const userKey = getUserKey(handle);
    for (const record of generations.values()) {
        if (record.userKey === userKey && record.characterId === characterId && !isTerminal(record.status)) {
            throw new ApiError(409, 'conflict', 'This character has an active generation. Wait for it to finish before changing the card.');
        }
    }
}

/**
 * Serializes work on one chat file so two detached generations cannot read the
 * same JSONL and clobber each other's commit.
 * @param {string} chatPath Chat file path
 * @param {() => Promise<any>} work Work to run
 * @returns {Promise<any>} Work result
 */
export async function withChatLock(chatPath, work) {
    const previous = chatLocks.get(chatPath) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    chatLocks.set(chatPath, current);
    await previous;
    try {
        return await work();
    } finally {
        release();
        if (chatLocks.get(chatPath) === current) chatLocks.delete(chatPath);
    }
}

/**
 * Gets the journal directory for a user.
 * @param {Record<string, string>} directories User directories
 * @returns {string} Journal directory
 */
function journalDirectory(directories) {
    return path.join(directories.root, JOURNAL_DIRECTORY);
}

/**
 * Persists a terminal (or accepted) record so a client can re-attach after a
 * server restart. In-flight records are restored as `unknown` — never replayed.
 * @param {Record<string, string>} directories User directories
 * @param {GenerationRecord} record Generation record
 * @returns {void}
 */
export function persistGeneration(directories, record) {
    try {
        const dir = journalDirectory(directories);
        fs.mkdirSync(dir, { recursive: true });
        const body = {
            requestId: record.requestId,
            userKey: record.userKey,
            clientRequestId: record.clientRequestId,
            characterId: record.characterId,
            chatId: record.chatId,
            type: record.type,
            status: record.status,
            seq: record.seq,
            text: record.text,
            reasoning: record.reasoning,
            error: record.error,
            committed: record.committed,
            cancelOutcome: record.cancelOutcome,
            usage: record.usage ?? null,
            pluginEvents: record.pluginEvents ?? [],
            createdAt: record.createdAt,
            finishedAt: record.finishedAt ?? null,
            snapshot: record.snapshot ?? null,
        };
        writeFileAtomicSync(path.join(dir, `${record.requestId}.json`), JSON.stringify(body), 'utf8');
    } catch (error) {
        console.warn('[api-v1] Could not persist generation journal:', error instanceof Error ? error.message : error);
    }
}

/**
 * Restores the persisted journal for a user directory. Terminal records are
 * readable after a restart; records that were still in flight are marked
 * `unknown` with an explicit reason and are never replayed automatically.
 * @param {Record<string, string>} directories User directories
 * @returns {number} Number of restored records
 */
export function restoreGenerations(directories) {
    const dir = journalDirectory(directories);
    if (restoredDirectories.has(dir)) return 0;
    restoredDirectories.add(dir);
    if (!fs.existsSync(dir)) return 0;
    let restored = 0;
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.json')).slice(-MAX_RESTORED_RECORDS * 2);
    for (const file of files) {
        try {
            const body = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
            if (!body?.requestId || generations.has(body.requestId)) continue;
            const inFlight = !['done', 'error', 'unknown', 'cancelled'].includes(body.status);
            /** @type {GenerationRecord} */
            const record = {
                requestId: body.requestId,
                userKey: body.userKey,
                clientRequestId: body.clientRequestId,
                characterId: body.characterId,
                chatId: body.chatId,
                type: body.type,
                status: inFlight ? 'unknown' : body.status,
                seq: Number(body.seq ?? 0),
                text: String(body.text ?? ''),
                reasoning: String(body.reasoning ?? ''),
                events: [],
                subscribers: new Set(),
                controller: new AbortController(),
                heartbeat: setInterval(() => {}, 0x7fffffff),
                createdAt: Number(body.createdAt ?? Date.now()),
                finishedAt: body.finishedAt ?? Date.now(),
                error: inFlight
                    ? { code: 'unknown', message: 'Generation was interrupted by a server restart.', retryable: false }
                    : body.error,
                cancelOutcome: body.cancelOutcome ?? (inFlight ? 'unknown' : null),
                committed: Boolean(body.committed),
                snapshot: body.snapshot ?? null,
                usage: body.usage ?? null,
                pluginEvents: Array.isArray(body.pluginEvents) ? body.pluginEvents : [],
                restored: true,
            };
            record.heartbeat.unref?.();
            clearInterval(record.heartbeat);
            generations.set(record.requestId, record);
            idempotency.set(`${record.userKey}:${record.clientRequestId}`, record.requestId);
            restored++;
        } catch (error) {
            console.warn('[api-v1] Ignoring corrupt generation journal entry:', file, error instanceof Error ? error.message : error);
        }
    }
    return restored;
}

/**
 * Creates or returns an idempotent generation record.
 * @param {object} options Creation options
 * @param {string} options.handle User handle
 * @param {string} options.clientRequestId Client idempotency key
 * @param {string} options.characterId Character identifier
 * @param {string} options.chatId Chat identifier
 * @param {string} options.type Generation type
 * @returns {{record: GenerationRecord, existing: boolean}} Generation record
 */
export function createGeneration({ handle, clientRequestId, characterId, chatId, type, directories }) {
    if (directories) restoreGenerations(directories);
    if (typeof clientRequestId !== 'string' || clientRequestId.length === 0 || clientRequestId.length > 200) {
        throw new ApiError(400, 'validation', 'clientRequestId must be a non-empty string up to 200 characters.');
    }
    const userKey = getUserKey(handle);
    const key = `${userKey}:${clientRequestId}`;
    const existingId = idempotency.get(key);
    const existing = existingId ? generations.get(existingId) : null;
    if (existing && existing.createdAt + IDEMPOTENCY_TTL_MS > Date.now()) {
        if (existing.characterId !== characterId || existing.chatId !== chatId || existing.type !== type) {
            throw new ApiError(409, 'conflict', 'clientRequestId was already used for a different generation.');
        }
        return { record: existing, existing: true };
    }
    /** @type {GenerationRecord} */
    const record = {
        requestId: crypto.randomUUID(),
        userKey,
        clientRequestId,
        characterId,
        chatId,
        type,
        status: 'accepted',
        seq: 0,
        text: '',
        reasoning: '',
        events: [],
        subscribers: new Set(),
        controller: new AbortController(),
        heartbeat: setInterval(() => emit(record, 'heartbeat', {}), 15_000),
        createdAt: Date.now(),
        error: null,
        cancelOutcome: null,
        committed: false,
        usage: null,
        pluginEvents: [],
        restored: false,
        directories: directories ?? null,
    };
    record.heartbeat.unref?.();
    generations.set(record.requestId, record);
    idempotency.set(key, record.requestId);
    emit(record, 'accepted', { requestId: record.requestId, status: record.status });
    persistGenerationIfPossible(record);
    return { record, existing: false };
}

/**
 * Gets a generation visible to the given user.
 * @param {string} requestId Request identifier
 * @param {string} handle User handle
 * @returns {GenerationRecord} Generation record
 */
export function getGeneration(requestId, handle, directories) {
    if (directories) restoreGenerations(directories);
    const record = generations.get(requestId);
    if (!record || record.userKey !== getUserKey(handle)) {
        throw new ApiError(404, 'not_found', 'Generation not found.');
    }
    return record;
}

/**
 * Persists a record if its owning user directories are known.
 * @param {GenerationRecord} record Generation record
 * @returns {void}
 */
function persistGenerationIfPossible(record) {
    if (record.directories) persistGeneration(record.directories, record);
}

/**
 * Records bounded plugin events on a generation and emits them to subscribers.
 * @param {GenerationRecord} record Generation record
 * @param {Array<Record<string, any>>} events Plugin events
 * @returns {void}
 */
export function recordPluginEvents(record, events) {
    if (!Array.isArray(events)) return;
    for (const event of events.slice(0, MAX_PLUGIN_EVENTS)) {
        const item = { event: String(event.event ?? 'plugin'), data: event.data ?? {}, extensionId: String(event.extensionId ?? '') };
        record.pluginEvents.push(item);
        emit(record, 'plugin', item);
    }
    if (record.pluginEvents.length > MAX_PLUGIN_EVENTS) {
        record.pluginEvents.splice(0, record.pluginEvents.length - MAX_PLUGIN_EVENTS);
    }
}

/**
 * Attaches provider usage information to a generation.
 * @param {GenerationRecord} record Generation record
 * @param {Record<string, any>|null} usage Provider usage
 * @returns {void}
 */
export function setUsage(record, usage) {
    if (!usage || typeof usage !== 'object') return;
    record.usage = {
        promptTokens: Number(usage.prompt_tokens ?? usage.promptTokens ?? 0),
        completionTokens: Number(usage.completion_tokens ?? usage.completionTokens ?? 0),
        totalTokens: Number(usage.total_tokens ?? usage.totalTokens ?? 0),
    };
}

/**
 * Emits a generation event to the snapshot and live subscribers.
 * @param {GenerationRecord} record Generation record
 * @param {string} type Event type
 * @param {Record<string, any>} data Event data
 * @returns {GenerationEvent} Emitted event
 */
export function emit(record, type, data) {
    const event = { seq: ++record.seq, type, data };
    if (type !== 'heartbeat') {
        record.events.push(event);
        if (record.events.length > 500) record.events.shift();
    }
    const payload = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...data, seq: event.seq, requestId: record.requestId })}\n\n`;
    for (const response of record.subscribers) {
        if (response.writableEnded) {
            record.subscribers.delete(response);
            continue;
        }
        response.write(payload);
    }
    return event;
}

/**
 * Emits a stage event.
 * @param {GenerationRecord} record Generation record
 * @param {string} stage Stage name
 * @returns {void}
 */
export function stage(record, stage) {
    emit(record, 'stage', { stage });
}

/**
 * Appends a streamed token.
 * @param {GenerationRecord} record Generation record
 * @param {string} token Token text
 * @param {boolean} [isReasoning] Whether this is reasoning content
 * @returns {void}
 */
export function appendToken(record, token, isReasoning = false) {
    if (!token) return;
    if (isReasoning) {
        record.reasoning += token;
        emit(record, 'reasoning', { text: token });
    } else {
        record.text += token;
        emit(record, 'token', { text: token });
    }
}

/**
 * Replaces the accumulated final text after post-generation hooks. The
 * token stream is left intact for reattachment; only the snapshot text is
 * updated so polling clients see the same text that was committed to the chat.
 * @param {GenerationRecord} record Generation record
 * @param {string} text Final transformed text
 * @returns {void}
 */
export function setFinalText(record, text) {
    const finalText = String(text ?? '');
    if (Buffer.byteLength(finalText) > 8_388_608) throw new ApiError(502, 'unknown', 'Transformed output exceeded its size limit; the generated text was not committed.');
    record.text = finalText;
}

/**
 * Adds an SSE subscriber and sends current events after the given sequence.
 * @param {GenerationRecord} record Generation record
 * @param {import('express').Response} response Express response
 * @param {number} [afterSeq] Last received event sequence
 * @returns {() => void} Unsubscribe function
 */
export function subscribe(record, response, afterSeq = 0) {
    response.status(200);
    response.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    response.flushHeaders?.();
    record.subscribers.add(response);
    for (const event of record.events) {
        if (event.seq > afterSeq) {
            response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event.data, seq: event.seq, requestId: record.requestId })}\n\n`);
        }
    }
    if (isTerminal(record.status)) {
        response.end();
        record.subscribers.delete(response);
    }
    return () => record.subscribers.delete(response);
}

/**
 * Marks a generation as cancelled, unless it already reached a terminal state.
 * @param {GenerationRecord} record Generation record
 * @param {string} outcome Cancellation outcome
 * @returns {boolean} Whether cancellation changed the state
 */
export function cancel(record, outcome = 'requested') {
    record.cancelOutcome = outcome;
    if (isTerminal(record.status)) return false;
    record.status = 'cancelled';
    record.controller.abort();
    emit(record, 'cancelled', { outcome, committed: record.committed });
    finish(record);
    return true;
}

/**
 * Marks a generation as failed.
 * @param {GenerationRecord} record Generation record
 * @param {string} code Error code
 * @param {string} message Error message
 * @param {boolean} [retryable] Whether retry is allowed
 * @returns {void}
 */
export function fail(record, code, message, retryable = false) {
    if (isTerminal(record.status)) return;
    record.status = code === 'unknown' ? 'unknown' : 'error';
    record.error = { code, message, retryable };
    emit(record, 'error', { code, message, retryable, committed: record.committed });
    finish(record);
}

/**
 * Marks a generation complete with its final message/result snapshot.
 * @param {GenerationRecord} record Generation record
 * @param {Record<string, any>} snapshot Final snapshot
 * @param {{committed?: boolean}} [options] Whether a transcript row was committed
 * @returns {void}
 */
export function complete(record, snapshot, { committed = true } = {}) {
    if (isTerminal(record.status)) return;
    record.status = 'done';
    record.snapshot = snapshot;
    record.committed = committed;
    emit(record, 'message', snapshot);
    emit(record, 'done', { status: record.status, committed: record.committed, usage: record.usage ?? null });
    finish(record);
}

/**
 * Cleans up timers and schedules retention expiry.
 * @param {GenerationRecord} record Generation record
 * @returns {void}
 */
function finish(record) {
    record.finishedAt = Date.now();
    persistGenerationIfPossible(record);
    clearInterval(record.heartbeat);
    for (const response of record.subscribers) {
        response.end();
    }
    record.subscribers.clear();
    const timeout = setTimeout(() => {
        generations.delete(record.requestId);
        for (const [key, value] of idempotency) {
            if (value === record.requestId) idempotency.delete(key);
        }
    }, TERMINAL_TTL_MS);
    timeout.unref?.();
}

/**
 * Gets the public snapshot of a generation.
 * @param {GenerationRecord} record Generation record
 * @returns {Record<string, any>} Generation snapshot
 */
export function snapshot(record) {
    return {
        requestId: record.requestId,
        clientRequestId: record.clientRequestId,
        characterId: record.characterId,
        chatId: record.chatId,
        type: record.type,
        status: record.status,
        seq: record.seq,
        text: record.text,
        reasoning: record.reasoning,
        error: record.error,
        committed: record.committed,
        cancelOutcome: record.cancelOutcome,
        usage: record.usage ?? null,
        pluginEvents: record.pluginEvents ?? [],
        restored: Boolean(record.restored),
        createdAt: new Date(record.createdAt).toISOString(),
        finishedAt: record.finishedAt ? new Date(record.finishedAt).toISOString() : null,
        snapshot: record.snapshot ?? null,
        urls: generationUrls(record.requestId),
    };
}

/**
 * Gets stable generation URLs.
 * @param {string} requestId Generation identifier
 * @returns {Record<string, string>} URLs
 */
export function generationUrls(requestId) {
    const base = `/api/v1/generations/${encodeURIComponent(requestId)}`;
    return { snapshotUrl: base, eventUrl: `${base}/events`, cancelUrl: `${base}/cancel` };
}

/**
 * Checks whether a status is terminal.
 * @param {string} status Status
 * @returns {boolean} Whether terminal
 */
export function isTerminal(status) {
    return ['done', 'error', 'unknown', 'cancelled'].includes(status);
}

/**
 * Clears all generation state. Intended for tests.
 * @returns {void}
 */
export function clearGenerations() {
    for (const record of generations.values()) {
        clearInterval(record.heartbeat);
        for (const response of record.subscribers) response.end();
    }
    generations.clear();
    idempotency.clear();
    restoredDirectories.clear();
    chatLocks.clear();
}
