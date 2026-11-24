import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { ApiError } from './contract.js';

export const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Escaped text/reasoning can appear in both the stream and final snapshot.
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const initialized = new Set();
export const journalDirectory = (directories: any) => path.join(directories.root, 'api-v1-generations');
const indexName = (userKey: any, clientRequestId: any) => `client-${crypto.createHash('sha256').update(`${userKey}\0${clientRequestId}`).digest('hex')}.json`;
export const storageFailure = () => new ApiError(503, 'storage', 'Generation storage could not be verified or synchronized. Inspect the chat; do not automatically repeat the request.');

export function syncDirectory(directory: any) {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function durableJson(file: any, value: any) {
    try {
        const dir = path.dirname(file);
        fs.mkdirSync(dir, { recursive: true });
        if (fs.lstatSync(dir).isSymbolicLink()) throw storageFailure();
        syncDirectory(path.dirname(dir));
        writeFileAtomicSync(file, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, fsync: true });
        syncDirectory(dir);
    } catch { throw storageFailure(); }
}

function readJson(file: any, maxBytes = MAX_SNAPSHOT_BYTES) {
    try {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) throw storageFailure();
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { throw storageFailure(); }
}

function validate(body: any) {
    if (!body || !REQUEST_ID.test(body.requestId) || typeof body.userKey !== 'string' || typeof body.clientRequestId !== 'string' || typeof body.characterId !== 'string' || typeof body.chatId !== 'string' || !Number.isFinite(body.createdAt)) throw storageFailure();
    if (body.targetKind != null && !['character', 'group'].includes(body.targetKind)) throw storageFailure();
    return body;
}

export function legacyUncertain(body: any) {
    const untracked = body.drained == null || body.providerDispatched == null;
    return untracked && (body.status === 'cancelled' || (body.status === 'error' && body.error?.code === 'internal'));
}

function summary(body: any) {
    return {
        requestId: body.requestId, userKey: body.userKey, clientRequestId: body.clientRequestId,
        characterId: body.characterId, chatId: body.chatId, type: body.type, targetKind: body.targetKind ?? 'character',
        fingerprint: body.fingerprint ?? null, status: legacyUncertain(body) && body.status === 'error' ? 'unknown' : body.status,
        createdAt: body.createdAt, finishedAt: body.finishedAt ?? null,
        committed: Boolean(body.committed), drained: body.drained !== false,
        seq: body.seq ?? 0, acknowledged: !legacyUncertain(body) && (body.acknowledged === true || (body.acknowledged == null && body.status === 'done')), cancelOutcome: legacyUncertain(body) ? 'unknown' : body.cancelOutcome ?? null,
    };
}

/** Canonical snapshot first, durable client-key index second; never dispatch before both. */
export function writeJournal(directories: any, body: any) {
    validate(body);
    const dir = journalDirectory(directories);
    try {
        durableJson(path.join(dir, `${body.requestId}.json`), body);
        durableJson(path.join(dir, indexName(body.userKey, body.clientRequestId)), summary(body));
    } catch (error) { initialized.delete(dir); throw error; }
}

/** Migrate every legacy record once, without an arbitrary last-N recovery window. */
export function initializeJournal(directories: any) {
    const dir = journalDirectory(directories);
    if (initialized.has(dir)) return;
    try {
        if (!fs.existsSync(dir)) { initialized.add(dir); return; }
        if (fs.lstatSync(dir).isSymbolicLink()) throw storageFailure();
        const files = fs.readdirSync(dir).filter(name => name.endsWith('.json') && REQUEST_ID.test(name.slice(0, -5)));
        for (const file of files) {
            const body = validate(readJson(path.join(dir, file)));
            if (body.requestId !== file.slice(0, -5)) throw storageFailure();
            const index = path.join(dir, indexName(body.userKey, body.clientRequestId));
            if (fs.existsSync(index)) {
                const prior = validate(readJson(index, 16384));
                if (prior.requestId !== body.requestId) throw storageFailure();
            } else durableJson(index, summary(body));
        }
        initialized.add(dir);
    } catch { throw storageFailure(); }
}

export function readJournal(directories: any, requestId: any) {
    if (!REQUEST_ID.test(requestId)) return null;
    const file = path.join(journalDirectory(directories), `${requestId}.json`);
    if (!fs.existsSync(file)) return null;
    const body = validate(readJson(file));
    if (body.requestId !== requestId) throw storageFailure();
    return body;
}

export function readClientJournal(directories: any, userKey: any, clientRequestId: any) {
    initializeJournal(directories);
    const index = path.join(journalDirectory(directories), indexName(userKey, clientRequestId));
    if (!fs.existsSync(index)) return null;
    const item = validate(readJson(index, 16384));
    if (item.userKey !== userKey || item.clientRequestId !== clientRequestId) throw storageFailure();
    const body = readJournal(directories, item.requestId);
    if (!body || body.userKey !== userKey || body.clientRequestId !== clientRequestId) throw storageFailure();
    return body;
}

export function journalEntries(directories: any) {
    initializeJournal(directories);
    const dir = journalDirectory(directories);
    if (!fs.existsSync(dir)) return [];
    try {
        const files = fs.readdirSync(dir).filter(name => /^client-[a-f0-9]{64}\.json$/.test(name));
        return files.map(file => validate(readJson(path.join(dir, file), 16384))).sort((a, b) => b.createdAt - a.createdAt || b.requestId.localeCompare(a.requestId));
    } catch { throw storageFailure(); }
}

export function clearJournalCache() { initialized.clear(); }
