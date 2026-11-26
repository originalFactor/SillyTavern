import crypto from 'node:crypto';
import fetch from 'node-fetch';
import { ApiError } from './contract.js';
import { redactProviderText } from './redaction.js';
import { readSettings, type HeadlessSession } from './session.js';

type Status = { onlineStatus: 'no_connection' | 'Valid'; state: 'unchecked' | 'checking' | 'valid' | 'failed'; checkedAt: number | null };
type Observation = { identity: string; value: Status; controller?: AbortController };
const observations = new Map<string, Observation>();
const identityKey = crypto.randomBytes(32);
const freshnessMs = 300_000;
const unchecked = (): Status => ({ onlineStatus: 'no_connection', state: 'unchecked', checkedAt: null });

// These observations are ephemeral and never authorize generation. Private
// fingerprints bind them to the current settings AND matching vault value.
// Neither credential values nor connection identities leave this module.
async function connection(session: HeadlessSession) {
    const { readSecret, SECRET_KEYS } = await import('../endpoints/secrets.js');
    // No await between the settings read and the matching vault read.
    const settings = readSettings(session.directories);
    const oai = settings.oai_settings ?? {};
    const source = oai.chat_completion_source ?? 'openai';
    const key = source === 'custom' ? readSecret(session.directories, SECRET_KEYS.CUSTOM, null) : source === 'openai' ? readSecret(session.directories, SECRET_KEYS.OPENAI, null) : null;
    const identity = crypto.createHmac('sha256', identityKey).update(JSON.stringify([settings.main_api, oai, key])).digest('hex');
    let url: URL | undefined, error: ApiError | undefined;
    if (settings.main_api !== 'openai' || !['openai', 'custom'].includes(source)) error = new ApiError(422, 'unsupported', 'Connection checks support only OpenAI Chat Completions and compatible custom endpoints.');
    else if (!key) error = new ApiError(409, 'conflict', 'Save a provider API key before checking the connection.');
    else {
        try {
            if (source === 'custom' && (typeof oai.custom_url !== 'string' || !oai.custom_url.trim())) throw Error('missing');
            url = new URL(source === 'custom' ? oai.custom_url.trim() : 'https://api.openai.com/v1');
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('invalid');
            url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
        } catch { error = new ApiError(422, 'validation', 'Provider base URL must use absolute HTTP(S) without credentials, query or fragment.'); }
    }
    return { identity, key, url, error };
}

export function invalidateProviderStatus(session: HeadlessSession) {
    const previous = observations.get(session.directories.root);
    observations.delete(session.directories.root);
    previous?.controller?.abort();
}

function current(session: HeadlessSession, identity: string) {
    const entry = observations.get(session.directories.root);
    if (entry && (entry.identity !== identity || (entry.value.checkedAt !== null && Date.now() - entry.value.checkedAt >= freshnessMs))) {
        invalidateProviderStatus(session);
        return undefined;
    }
    return entry;
}

/** Observation only: this GET path never contacts a provider. */
export async function readProviderStatus(session: HeadlessSession): Promise<Status> {
    const captured = await connection(session);
    const entry = current(session, captured.identity);
    if (captured.error) { invalidateProviderStatus(session); return unchecked(); }
    return entry ? { ...entry.value } : unchecked();
}

/** Explicit user action; one bounded GET /models, no redirects or replay. */
export async function checkProviderStatus(session: HeadlessSession): Promise<Status> {
    const captured = await connection(session);
    const previous = current(session, captured.identity);
    if (previous?.controller) throw new ApiError(409, 'conflict', 'A provider connection check is already running.');
    if (captured.error) { invalidateProviderStatus(session); throw captured.error; }
    if (!observations.has(session.directories.root) && observations.size >= 128) {
        const idle = [...observations].find(([, entry]) => !entry.controller);
        if (!idle) throw new ApiError(409, 'conflict', 'Too many provider connection checks are running.');
        observations.delete(idle[0]);
    }
    const controller = new AbortController();
    const entry: Observation = { identity: captured.identity, value: { onlineStatus: 'no_connection', state: 'checking', checkedAt: null }, controller };
    observations.set(session.directories.root, entry);
    const timeout = setTimeout(() => controller.abort(), 10_000);
    timeout.unref?.();
    const stillCurrent = async () => {
        try {
            const latest = await connection(session);
            return observations.get(session.directories.root) === entry && latest.identity === captured.identity;
        } catch { return false; }
    };
    try {
        const response = await fetch(captured.url!.toString(), {
            method: 'GET', headers: { Authorization: `Bearer ${captured.key}`, Accept: 'application/json' },
            redirect: 'manual', size: 2_097_152, signal: controller.signal,
        });
        if (!response.ok) {
            let detail = '';
            try { detail = (await response.text()).slice(0, 8192); } catch { /* Bounded or interrupted error body. */ }
            throw new ApiError(502, 'provider', `Connection check returned HTTP ${response.status}: ${redactProviderText(detail, [captured.key]) || 'Provider rejected the request.'}`, { retryable: false });
        }
        let payload: any;
        try { payload = await response.json(); } catch { throw new ApiError(502, 'provider', 'Connection check returned invalid or oversized JSON.'); }
        const models = payload?.data ?? payload?.models;
        if (!payload || Object.hasOwn(payload, 'error') || !Array.isArray(models) || models.length > 2000 || models.some(row => !row || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 1024)) throw new ApiError(502, 'provider', 'Connection check did not return a bounded model catalog.');
        if (!await stillCurrent() || observations.get(session.directories.root) !== entry) throw new ApiError(409, 'conflict', 'Provider configuration changed during the connection check. Check the current configuration explicitly.');
        entry.value = { onlineStatus: 'Valid', state: 'valid', checkedAt: Date.now() };
        return { ...entry.value };
    } catch (error) {
        if (!await stillCurrent()) {
            if (observations.get(session.directories.root) === entry) invalidateProviderStatus(session);
            throw new ApiError(409, 'conflict', 'Provider configuration changed during the connection check. Check the current configuration explicitly.');
        }
        entry.value = { onlineStatus: 'no_connection', state: 'failed', checkedAt: Date.now() };
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, 'provider', 'Provider connection check failed or timed out.', { retryable: false });
    } finally { clearTimeout(timeout); entry.controller = undefined; }
}
