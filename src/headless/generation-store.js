import crypto from 'node:crypto';

import { clearJournalCache, initializeJournal, journalEntries, legacyUncertain, readClientJournal, readJournal, writeJournal, storageFailure } from './generation-journal.js';
import { acquireGenerationOwner } from './generation-owner.js';
import { ApiError, getUserKey } from './contract.js';

const TERMINAL_TTL_MS = 5 * 60 * 1000;
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
export function assertChatIdle(handle, characterId, chatId, directories = null) {
    if (directories) restoreGenerations(directories);
    const userKey = getUserKey(handle);
    for (const record of generations.values()) {
        if (record.userKey === userKey && record.characterId === characterId && record.chatId === chatId && (!isTerminal(record.status) || record.workerActive)) {
            throw new ApiError(409, 'conflict', 'This chat has an active generation. Stop it and wait for completion before changing history.');
        }
    }
    for (const entry of directories ? journalEntries(directories) : []) {
        const record = generations.get(entry.requestId) ?? entry;
        if (record.userKey === userKey && record.characterId === characterId && record.chatId === chatId && !record.acknowledged && (record.status === 'unknown' || (record.status === 'cancelled' && record.cancelOutcome === 'unknown'))) throw new ApiError(409, 'conflict', 'This chat has an unresolved generation outcome. Inspect and acknowledge it before changing history.');
    }
}

/**
 * Reject character mutation/deletion while any of its turns can still commit.
 * @param {string} handle User handle
 * @param {string} characterId Character identifier
 * @returns {void}
 */
export function assertCharacterIdle(handle, characterId, directories = null) {
    if (directories) restoreGenerations(directories);
    const userKey = getUserKey(handle);
    for (const record of generations.values()) {
        if (record.userKey === userKey && record.characterId === characterId && (!isTerminal(record.status) || record.workerActive)) {
            throw new ApiError(409, 'conflict', 'This character has an active generation. Wait for it to finish before changing the card.');
        }
    }
    for (const entry of directories ? journalEntries(directories) : []) {
        const record = generations.get(entry.requestId) ?? entry;
        if (record.userKey === userKey && record.characterId === characterId && !record.acknowledged && (record.status === 'unknown' || (record.status === 'cancelled' && record.cancelOutcome === 'unknown'))) throw new ApiError(409, 'conflict', 'This character has an unresolved generation outcome. Inspect and acknowledge it before changing the card.');
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

const memoryKey = (directories, userKey, clientRequestId) => `${directories?.root ?? ''}:${userKey}:${clientRequestId}`;
function clientId(value) {
    if (typeof value !== 'string' || !value || value.length > 200) throw new ApiError(400, 'validation', 'clientRequestId must be a non-empty string up to 200 characters.');
    return value;
}
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}

/** Persist synchronously; storage failure is never an admission success. */
export function persistGeneration(directories, record) {
    if (globalThis.DATA_ROOT) acquireGenerationOwner(globalThis.DATA_ROOT);
    const body = Object.fromEntries([
        'requestId', 'userKey', 'clientRequestId', 'characterId', 'chatId', 'type',
        'fingerprint', 'status', 'seq', 'text', 'reasoning', 'error', 'committed',
        'cancelOutcome', 'cancelRequested', 'providerDispatched', 'drained',
        'acknowledged', 'usage', 'pluginEvents', 'createdAt', 'finishedAt', 'snapshot',
    ].map(key => [key, record[key] ?? null]));
    writeJournal(directories, body);
    record.lastPersistedAt = Date.now();
    record.dirty = false;
}

function hydrate(body, directories) {
    const existing = generations.get(body.requestId);
    if (existing) return existing;
    const inFlight = !isTerminal(body.status);
    const legacyAmbiguous = legacyUncertain(body);
    const storedFullText = body.type === 'quiet' ? body.snapshot?.text : body.snapshot?.message?.mes;
    const repairedText = typeof storedFullText === 'string' && typeof body.text === 'string' && body.text.length === 64 * 1024 && storedFullText.length > body.text.length && storedFullText.startsWith(body.text) ? storedFullText : String(body.text ?? '');
    const quietCommitFix = body.type === 'quiet' && body.status === 'done' && body.committed;
    const record = {
        ...body, text: repairedText, reasoning: String(body.reasoning ?? ''),
        status: inFlight || (legacyAmbiguous && body.status === 'error') ? 'unknown' : body.status,
        error: inFlight || (legacyAmbiguous && body.status === 'error') ? { code: 'unknown', message: 'Generation was interrupted by a server restart or an incomplete admission. Inspect the chat and acknowledge the outcome; it was not replayed.', retryable: false } : body.error,
        cancelOutcome: inFlight || legacyAmbiguous ? 'unknown' : body.cancelOutcome,
        committed: quietCommitFix ? false : Boolean(body.committed),
        providerDispatched: body.providerDispatched ?? (inFlight || legacyAmbiguous || body.status === 'done'),
        events: [], subscribers: new Set(), controller: new AbortController(),
        heartbeat: null, directories, workerActive: false, drained: true,
        acknowledged: inFlight || legacyAmbiguous ? false : body.acknowledged === true || (body.acknowledged == null && body.status === 'done'),
        restored: true, lastPersistedAt: 0,
    };
    if (inFlight || body.drained === false || legacyAmbiguous || quietCommitFix || repairedText !== body.text) persistGeneration(directories, record);
    generations.set(record.requestId, record);
    idempotency.set(memoryKey(directories, record.userKey, record.clientRequestId), record.requestId);
    return record;
}

export function restoreGenerations(directories) {
    if (globalThis.DATA_ROOT) acquireGenerationOwner(globalThis.DATA_ROOT);
    const key = directories.root;
    if (restoredDirectories.has(key)) return 0;
    initializeJournal(directories);
    const entries = journalEntries(directories);
    // Cache recent terminal results, but restore every interrupted admission.
    // Older results remain directly addressable through their durable index.
    const recent = entries.filter((entry, index) => index < MAX_RESTORED_RECORDS || !isTerminal(entry.status));
    let restored = 0;
    for (const entry of recent) {
        if (generations.has(entry.requestId)) continue;
        const body = readJournal(directories, entry.requestId);
        if (!body) throw storageFailure();
        hydrate(body, directories);
        restored++;
    }
    restoredDirectories.add(key);
    return restored;
}

export function createGeneration({ handle, clientRequestId, characterId, chatId, type, directories, requestIdentity, reservationOnly = false }) {
    clientId(clientRequestId);
    if (directories) restoreGenerations(directories);
    const userKey = getUserKey(handle);
    const key = memoryKey(directories, userKey, clientRequestId);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(canonical(requestIdentity ?? { characterId, chatId, type }))).digest('hex');
    const existingId = idempotency.get(key);
    let existing = existingId ? generations.get(existingId) : null;
    if (!existing && directories) {
        const body = readClientJournal(directories, userKey, clientRequestId);
        if (body) existing = hydrate(body, directories);
    }
    if (existing) {
        if (!existing.fingerprint) throw new ApiError(409, 'conflict', 'A legacy request identity already exists. Inspect it with a read-only lookup instead of submitting another payload.');
        if (existing.characterId !== characterId || existing.chatId !== chatId || existing.type !== type || (existing.fingerprint && existing.fingerprint !== fingerprint)) throw new ApiError(409, 'conflict', 'clientRequestId was already used for a different generation payload.');
        return { record: existing, existing: true };
    }
    if (!reservationOnly) assertChatIdle(handle, characterId, chatId);
    for (const entry of reservationOnly ? [] : directories ? journalEntries(directories) : generations.values()) {
        if (entry.userKey !== userKey || entry.characterId !== characterId || entry.chatId !== chatId) continue;
        if (isTerminal(entry.status) && !['unknown', 'cancelled'].includes(entry.status)) continue;
        const record = generations.get(entry.requestId) ?? (directories ? hydrate(readJournal(directories, entry.requestId) ?? (() => { throw storageFailure(); })(), directories) : entry);
        if (!record.acknowledged && (record.status === 'unknown' || (record.status === 'cancelled' && record.cancelOutcome === 'unknown'))) throw new ApiError(409, 'conflict', 'This chat has an unresolved generation outcome. Inspect the saved result and acknowledge it before sending again.');
    }
    const record = {
        requestId: crypto.randomUUID(), userKey, clientRequestId, characterId, chatId, type, fingerprint,
        status: 'accepted', seq: 0, text: '', reasoning: '', events: [], subscribers: new Set(),
        controller: new AbortController(), heartbeat: null, createdAt: Date.now(), error: null,
        cancelOutcome: null, cancelRequested: false, providerDispatched: false,
        workerActive: false, drained: true, acknowledged: false,
        committed: false, usage: null, pluginEvents: [], restored: false, directories: directories ?? null,
    };
    // Neither the record nor a billable worker is published before the snapshot
    // and permanent client-key index are both synchronized.
    persistGenerationIfPossible(record);
    generations.set(record.requestId, record);
    idempotency.set(key, record.requestId);
    record.heartbeat = setInterval(() => emit(record, 'heartbeat', {}), 15_000);
    record.heartbeat.unref?.();
    emit(record, 'accepted', { requestId: record.requestId, status: record.status });
    return { record, existing: false };
}

export function getGeneration(requestId, handle, directories) {
    if (directories) restoreGenerations(directories);
    let record = generations.get(requestId);
    if (!record && directories) {
        const body = readJournal(directories, requestId);
        if (body?.userKey === getUserKey(handle)) record = hydrate(body, directories);
    }
    if (!record || record.userKey !== getUserKey(handle) || (record.directories && directories && record.directories.root !== directories.root)) throw new ApiError(404, 'not_found', 'Generation not found.');
    return record;
}

export function getGenerationByClient(clientRequestId, handle, directories) {
    clientId(clientRequestId);
    restoreGenerations(directories);
    const userKey = getUserKey(handle);
    const cached = idempotency.get(memoryKey(directories, userKey, clientRequestId));
    if (cached) return getGeneration(cached, handle, directories);
    const body = readClientJournal(directories, userKey, clientRequestId);
    if (!body) throw new ApiError(404, 'not_found', 'Generation has not been admitted at this lookup. Reserve or stop this caller key before sending another request.');
    return hydrate(body, directories);
}

export function listGenerations(handle, directories, { characterId, chatId, before = '', limit = 20, unresolvedOnly = false }) {
    restoreGenerations(directories);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'validation', 'Generation page limit must be 1..100.');
    const userKey = getUserKey(handle);
    let entries = journalEntries(directories).filter(entry => entry.userKey === userKey && entry.characterId === characterId && entry.chatId === chatId);
    if (before) {
        const offset = entries.findIndex(entry => entry.requestId === before);
        if (offset < 0) throw new ApiError(400, 'validation', 'Generation cursor is not in this chat.');
        entries = entries.slice(offset + 1);
    }
    if (unresolvedOnly) entries = entries.filter(entry => {
        const item = generations.get(entry.requestId) ?? entry;
        return !isTerminal(item.status) || item.drained === false || (!item.acknowledged && (item.status === 'unknown' || (item.status === 'cancelled' && item.cancelOutcome === 'unknown')));
    });
    const page = entries.slice(0, limit).map(entry => {
        const record = generations.get(entry.requestId) ?? (!isTerminal(entry.status) ? getGeneration(entry.requestId, handle, directories) : entry);
        return { requestId: entry.requestId, clientRequestId: entry.clientRequestId, characterId, chatId,
            type: entry.type, status: record.status, seq: record.seq ?? 0, committed: Boolean(record.committed),
            drained: record.drained !== false, acknowledged: record.acknowledged === true,
            createdAt: new Date(entry.createdAt).toISOString() };
    });
    return { generations: page, hasMore: entries.length > limit, nextBefore: entries.length > limit ? page.at(-1).requestId : null };
}

export function abandonClientGeneration(handle, directories, clientRequestId, characterId, chatId) {
    clientId(clientRequestId);
    let existing;
    try { existing = getGenerationByClient(clientRequestId, handle, directories); } catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
    if (existing) {
        if (existing.characterId !== characterId || existing.chatId !== chatId) throw new ApiError(409, 'conflict', 'Request identity belongs to a different chat.');
        cancel(existing);
        return snapshot(existing);
    }
    // This synchronous durable reservation wins against any not-yet-admitted
    // delayed POST using the same caller key. It never dispatches a provider.
    const created = createGeneration({ handle, directories, clientRequestId, characterId, chatId, type: 'abandoned', reservationOnly: true });
    cancel(created.record);
    return snapshot(created.record);
}

function persistGenerationIfPossible(record) {
    if (record.directories) persistGeneration(record.directories, record);
}
function persistOutcome(record) {
    try { persistGenerationIfPossible(record); return true; } catch {
        record.status = 'unknown';
        if (record.error?.code !== 'storage') record.error = { code: 'storage', message: `The generation journal could not be synchronized. Inspect the chat and do not repeat automatically.${record.error?.message ? ' Previous result: ' + record.error.message : ''}`, retryable: false };
        record.acknowledged = false;
        return false;
    }
}

export const shouldStopGeneration = record => record.cancelRequested || isTerminal(record.status);
export function beginGeneration(record) {
    if (shouldStopGeneration(record)) return false;
    record.workerActive = true;
    record.drained = false;
    try { persistGenerationIfPossible(record); } catch (error) { record.workerActive = false; record.drained = true; fail(record, 'storage', error.message); return false; }
    if (record.directories) {
        record.checkpointTimer = setInterval(() => {
            if (!record.dirty || shouldStopGeneration(record)) return;
            try { persistGenerationIfPossible(record); } catch (error) {
                record.controller.abort();
                fail(record, 'unknown', error.message, false);
            }
        }, 500);
        record.checkpointTimer.unref?.();
    }
    return true;
}
export function markProviderDispatched(record) {
    if (shouldStopGeneration(record)) throw new ApiError(409, 'conflict', 'Generation was cancelled before provider dispatch.');
    record.providerDispatched = true;
    persistGenerationIfPossible(record);
}
export function endGeneration(record) {
    record.workerActive = false;
    record.drained = true;
    if (record.cancelRequested && (!isTerminal(record.status) || record.workerActive)) {
        record.status = 'cancelled';
        record.cancelOutcome = record.providerDispatched ? 'unknown' : 'cancelled';
        record.acknowledged = !record.providerDispatched;
        persistOutcome(record);
        emit(record, record.status === 'cancelled' ? 'cancelled' : 'error', { outcome: record.cancelOutcome, committed: record.committed, drained: true, ...record.error });
        finish(record);
    } else if (isTerminal(record.status)) persistOutcome(record);
}

export function acknowledgeGeneration(record, expectedSeq) {
    if (!isTerminal(record.status) || record.workerActive || !record.drained) throw new ApiError(409, 'conflict', 'Wait for the local generation worker to stop before acknowledging its outcome.');
    if (expectedSeq !== record.seq) throw new ApiError(409, 'conflict', 'Generation state changed. Refresh before acknowledging.');
    record.acknowledged = true;
    try { persistGenerationIfPossible(record); } catch (error) { record.acknowledged = false; throw error; }
    return snapshot(record);
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
    const fields = {
        promptTokens: usage.prompt_tokens ?? usage.promptTokens,
        completionTokens: usage.completion_tokens ?? usage.completionTokens,
        totalTokens: usage.total_tokens ?? usage.totalTokens,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cachedTokens,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoningTokens,
    };
    const reported = Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0));
    if (Object.keys(reported).length) record.usage = { ...(record.usage ?? {}), ...reported };
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
    record.dirty = true;
    if (record.directories && Date.now() - (record.lastPersistedAt ?? 0) >= 500) persistGenerationIfPossible(record);
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
export function setFinalReasoning(record, text) {
    const reasoning = String(text ?? '');
    if (Buffer.byteLength(reasoning) > 8_388_608) throw new ApiError(502, 'unknown', 'Transformed reasoning exceeded its size limit; the generated text was not committed.');
    record.reasoning = reasoning;
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
    if (isTerminal(record.status)) { record.cancelOutcome = 'unknown'; return false; }
    if (record.cancelRequested) return false;
    record.cancelRequested = true;
    record.cancelOutcome = outcome;
    record.status = 'cancelling';
    record.controller.abort();
    persistOutcome(record);
    emit(record, 'stage', { stage: 'cancelling', outcome });
    if (!record.workerActive) endGeneration(record);
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
    persistOutcome(record);
    emit(record, 'error', { ...record.error, committed: record.committed });
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
    record.acknowledged = true;
    if (!persistOutcome(record)) { emit(record, 'error', record.error); finish(record); return; }
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
    clearInterval(record.heartbeat);
    clearInterval(record.checkpointTimer);
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
        drained: record.drained !== false,
        acknowledged: record.acknowledged === true,
        providerDispatched: record.providerDispatched === true,
        cancelOutcome: record.cancelOutcome,
        usage: record.usage ?? null,
        warnings: record.snapshot?.warnings ?? null,
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
        clearInterval(record.checkpointTimer);
        for (const response of record.subscribers) response.end();
    }
    generations.clear();
    idempotency.clear();
    restoredDirectories.clear();
    clearJournalCache();
    chatLocks.clear();
}
