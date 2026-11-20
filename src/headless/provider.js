import yaml from 'yaml';

import { redactProviderText } from './redaction.js';
import { ApiError } from './contract.js';
import { appendToken, isTerminal } from './generation-store.js';

/**
 * @typedef {object} ProviderResult
 * @property {string} text Generated text
 * @property {string} reasoning Generated reasoning
 * @property {Record<string, any>|null} usage Provider usage counts
 */

/**
 * Sends the assembled Chat Completion request directly to the configured provider.
 * @param {import('express').Request} originalRequest Authenticated source request
 * @param {Record<string, any>} providerRequest Provider request body
 * @param {import('./generation-store.js').GenerationRecord} record Generation record
 * @returns {Promise<ProviderResult>} Provider result
 */
export async function runChatCompletion(originalRequest, providerRequest, record) {
    const { default: fetch, Headers } = await import('node-fetch');
    const { readSecret, SECRET_KEYS } = await import('../endpoints/secrets.js');
    const request = structuredClone(providerRequest);
    const source = String(request.chat_completion_source ?? 'openai');
    const url = source === 'custom'
        ? new URL('chat/completions', `${String(request.custom_url).replace(/\/?$/, '/')}`).toString()
        : 'https://api.openai.com/v1/chat/completions';
    const apiKey = source === 'custom'
        ? readSecret(originalRequest.user.directories, SECRET_KEYS.CUSTOM, null)
        : readSecret(originalRequest.user.directories, SECRET_KEYS.OPENAI, null);
    const headers = new Headers({ 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey ?? ''}` });
    mergeYamlIntoHeaders(headers, String(request.custom_include_headers ?? ''));
    const body = {
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        max_completion_tokens: request.max_completion_tokens,
        stream: true,
        presence_penalty: request.presence_penalty,
        frequency_penalty: request.frequency_penalty,
        top_p: request.top_p,
    };
    mergeYamlIntoObject(body, String(request.custom_include_body ?? ''));
    excludeKeysByYaml(body, String(request.custom_exclude_body ?? ''));
    const endpoint = new URL(url);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new ApiError(422, 'validation', 'Provider URL must use HTTP(S) without embedded credentials.');
    const secrets = [apiKey, originalRequest.headers?.authorization];
    for (const [key, value] of headers) if (/authorization|api.?key|cookie|token|secret/i.test(key)) secrets.push(value, value.replace(/^Bearer\s+/i, ''));
    const controller = new AbortController();
    const abort = () => controller.abort();
    record.controller.signal.addEventListener('abort', abort, { once: true });
    if (record.controller.signal.aborted) controller.abort();
    const timeout = setTimeout(abort, 300_000);
    timeout.unref?.();
    try {
        const response = await fetch(url, {
            method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
            redirect: 'manual', size: 8_388_608,
        });
        if (!response.ok) {
            let detail = '';
            const detailTimeout = setTimeout(abort, 3_000);
            detailTimeout.unref?.();
            try {
                let bytes = 0;
                for await (const chunk of response.body ?? []) {
                    bytes += chunk.length;
                    detail += chunk.toString('utf8');
                    if (bytes > 8192) { detail = detail.slice(0, 8192) + ' [truncated]'; response.body.destroy(); break; }
                }
            } catch { detail ||= 'Provider error details unavailable.'; } finally { clearTimeout(detailTimeout); }
            const safe = redactProviderText(detail, secrets);
            console.warn('[api-v1]', record.requestId, 'provider_error', response.status);
            throw new ApiError(502, 'provider', `HTTP ${response.status}: ${safe || 'Provider rejected the request.'}`, { retryable: false });
        }
        if (!response.body) throw new ApiError(502, 'unknown', 'Provider returned no response body; the generation outcome is unknown. Do not replay automatically.');
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().includes('text/event-stream')) {
            response.body.destroy();
            throw new ApiError(502, 'unknown', 'Provider did not return an SSE stream; the generation outcome is unknown.');
        }
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const stream = new ProviderSseDecoder(record, secrets);
        let bytes = 0;
        for await (const chunk of response.body) {
            if (isTerminal(record.status)) return { text: record.text, reasoning: record.reasoning, usage: stream.usage };
            bytes += chunk.length;
            if (bytes > 16_777_216) {
                response.body.destroy();
                throw new ApiError(502, 'unknown', 'Provider stream exceeded its size limit; the generation outcome is unknown.');
            }
            stream.push(decoder.decode(chunk, { stream: true }));
        }
        stream.push(decoder.decode(), true);
        if (!stream.completed) throw new ApiError(502, 'unknown', 'Provider stream ended without a completion marker. Partial text was not saved; the generation may have been billed.');
        if (!record.text) throw new ApiError(502, 'provider', 'Provider completed without text. The request may have been billed.');
        return { text: record.text, reasoning: record.reasoning, usage: stream.usage };
    } catch (error) {
        if (error instanceof ApiError) throw error;
        // A transport failure after dispatch cannot prove that the provider did
        // not execute the request. Never turn this into a replayable failure.
        throw new ApiError(502, 'unknown', `Provider connection failed; the generation outcome is unknown and may have been billed. ${redactProviderText(error?.type ?? 'transport_error', secrets)}`);
    } finally {
        clearTimeout(timeout);
        record.controller.signal.removeEventListener('abort', abort);
    }
}

/** Incremental bounded SSE decoder. A socket EOF alone is never success. */
export class ProviderSseDecoder {
    constructor(record, secrets = []) {
        this.record = record;
        this.secrets = secrets;
        this.buffer = '';
        this.usage = null;
        this.completed = false;
        this.done = false;
        this.outputBytes = 0;
    }

    push(text, flush = false) {
        this.buffer += text;
        const events = this.buffer.split(/\r\n\r\n|\n\n|\r\r/);
        this.buffer = events.pop() ?? '';
        if (flush && this.buffer.trim()) { events.push(this.buffer); this.buffer = ''; }
        if (this.buffer.length > 1_048_576 || events.some(event => event.length > 1_048_576)) throw new ApiError(502, 'unknown', 'Provider SSE event exceeded its size limit; the generation outcome is unknown.');
        for (const event of events) {
            const data = event.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            if (data === '[DONE]') { this.completed = true; this.done = true; continue; }
            if (this.done) throw new ApiError(502, 'unknown', 'Provider sent data after its completion marker.');
            const json = tryParseJson(data);
            if (!json) throw new ApiError(502, 'unknown', 'Provider returned malformed SSE data; the generation outcome is unknown.');
            if (json.error) {
                const detail = typeof json.error === 'string' ? json.error : String(json.error.message ?? 'Provider stream error.');
                throw new ApiError(502, 'provider', `Provider stream error: ${redactProviderText(detail, this.secrets)}`);
            }
            if (json.usage && typeof json.usage === 'object' && !Array.isArray(json.usage)) this.usage = publicUsage(json.usage);
            const choice = json.choices?.find?.(item => item.index === 0) ?? json.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta ?? choice.message ?? choice;
            if (delta.tool_calls?.length || delta.function_call || choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') throw new ApiError(422, 'unsupported', 'Provider requested tool execution, but the native tool authorization lifecycle is not configured.');
            if (choice.finish_reason) {
                if (!['stop', 'length', 'content_filter'].includes(choice.finish_reason)) throw new ApiError(502, 'unknown', 'Provider returned an unrecognized completion reason.');
                this.completed = true;
            }
            const content = extractText(delta.content ?? choice.text);
            const reasoning = extractText(delta.reasoning_content ?? delta.reasoning ?? choice.reasoning);
            this.outputBytes += Buffer.byteLength(content) + Buffer.byteLength(reasoning);
            if (this.outputBytes > 8_388_608) throw new ApiError(502, 'unknown', 'Provider output exceeded its size limit; the generation outcome is unknown.');
            appendToken(this.record, reasoning, true);
            appendToken(this.record, content);
        }
    }
}

function publicUsage(usage) {
    // Usage is numeric metadata, never an arbitrary echo of provider fields.
    const clean = {};
    for (const [key, value] of Object.entries(usage)) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) clean[key] = value;
        else if (value && typeof value === 'object' && !Array.isArray(value)) clean[key] = publicUsage(value);
    }
    return clean;
}

/**
 * Extracts text from OpenAI-compatible multimodal content.
 * @param {unknown} value Content value
 * @returns {string} Text
 */
function extractText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value.map(part => typeof part === 'string' ? part : String(part?.text ?? '')).join('');
    }
    return '';
}

/**
 * Parses JSON without throwing.
 * @param {string} text JSON text
 * @returns {Record<string, any>|null} Parsed object
 */
function tryParseJson(text) {
    try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * Merges YAML key/value settings into provider headers.
 * @param {import('node-fetch').Headers} target Headers target
 * @param {string} value YAML text
 * @returns {void}
 */
function mergeYamlIntoHeaders(target, value) {
    if (!value) return;
    try {
        const parsed = yaml.parse(value);
        const entries = Array.isArray(parsed)
            ? parsed.filter(item => item && typeof item === 'object' && !Array.isArray(item)).flatMap(Object.entries)
            : parsed && typeof parsed === 'object' ? Object.entries(parsed) : [];
        for (const [key, headerValue] of entries) target.set(key, String(headerValue));
    } catch {
        // Ignore invalid optional YAML, matching the existing provider route.
    }
}

/**
 * Merges YAML key/value settings into the provider request body.
 * @param {Record<string, any>} target Target object
 * @param {string} value YAML text
 * @returns {void}
 */
function mergeYamlIntoObject(target, value) {
    if (!value) return;
    try {
        const parsed = yaml.parse(value);
        if (Array.isArray(parsed)) {
            for (const item of parsed) if (item && typeof item === 'object' && !Array.isArray(item)) Object.assign(target, item);
        } else if (parsed && typeof parsed === 'object') {
            Object.assign(target, parsed);
        }
    } catch {
        // Ignore invalid optional YAML, matching the existing provider route.
    }
}

/**
 * Removes YAML-listed keys from a provider object.
 * @param {Record<string, any>} target Target object
 * @param {string} value YAML text
 * @returns {void}
 */
function excludeKeysByYaml(target, value) {
    if (!value) return;
    try {
        const parsed = yaml.parse(value);
        if (Array.isArray(parsed)) for (const key of parsed) delete target[String(key)];
    } catch {
        // Ignore invalid optional YAML, matching the existing provider route.
    }
}
