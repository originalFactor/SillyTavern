import yaml from 'yaml';

import { createSession } from './session.js';
import { publicConfiguration, redactProviderText } from './redaction.js';
import { ApiError } from './contract.js';
import { appendToken, isTerminal, markProviderDispatched, setToolCalls, setUsage } from './generation-store.js';
import { textProviderConnection, textProviderBody, TEXT_COMPLETION_SOURCES } from './text-provider.js';

// Credentials are deliberately outside the serializable session, prompt and
// journal. A worker keeps the exact connection authorized at admission.
const acceptedConnections = new WeakMap();

export async function prepareProviderSession(request) {
    const { readSecret, SECRET_KEYS } = await import('../endpoints/secrets.js');
    // No await between reading settings and the matching credential value.
    const session = createSession(request);
    if (session.settings.main_api === 'textgenerationwebui') {
        const connection = textProviderConnection(session.settings);
        const key = readSecret(session.directories, SECRET_KEYS[connection.secretName], null);
        acceptedConnections.set(session, { ...connection, key });
        return session;
    }
    const source = String(session.settings.oai_settings?.chat_completion_source ?? 'openai');
    const key = readSecret(session.directories, source === 'custom' ? SECRET_KEYS.CUSTOM : SECRET_KEYS.OPENAI, null);
    acceptedConnections.set(session, { format: 'chat-completions', source, key, url: String(session.settings.oai_settings?.custom_url ?? '') });
    return session;
}

export async function runSessionCompletion(request, providerRequest, record, session) {
    const connection = acceptedConnections.get(session);
    const format = providerRequest.provider_format ?? 'chat-completions';
    if (connection && (connection.format !== format || (format === 'text-completions'
        ? connection.source !== providerRequest.api_type || connection.url !== providerRequest.api_server
        : connection.source !== String(providerRequest.chat_completion_source ?? 'openai') || (connection.source === 'custom' && connection.url !== String(providerRequest.custom_url ?? ''))))) throw new ApiError(409, 'conflict', 'The accepted provider connection changed inside the generation.');
    return runChatCompletion(request, providerRequest, record, connection, session);
}
export const runSessionChatCompletion = runSessionCompletion;

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
export async function runChatCompletion(originalRequest, providerRequest, record, acceptedConnection = null, acceptedSession = null) {
    const { default: fetch, Headers } = await import('node-fetch');
    const { readSecret, SECRET_KEYS } = await import('../endpoints/secrets.js');
    const request = structuredClone(providerRequest);
    if (request.provider_format && !['chat-completions', 'text-completions'].includes(request.provider_format)) throw new ApiError(422, 'unsupported', 'Unknown native completion wire format.');
    const isText = request.provider_format === 'text-completions';
    if (isText && !Object.hasOwn(TEXT_COMPLETION_SOURCES, request.api_type)) throw new ApiError(422, 'unsupported', 'Unknown native text-completion source.');
    const source = String(request.chat_completion_source ?? 'openai');
    const url = isText ? String(request.api_server) : source === 'custom'
        ? new URL('chat/completions', `${String(request.custom_url).replace(/\/?$/, '/')}`).toString()
        : 'https://api.openai.com/v1/chat/completions';
    let apiKey = acceptedConnection?.key;
    if (apiKey === undefined) {
        if (isText) apiKey = readSecret(originalRequest.user.directories, SECRET_KEYS[TEXT_COMPLETION_SOURCES[request.api_type]], null);
        else if (source === 'custom') apiKey = readSecret(originalRequest.user.directories, SECRET_KEYS.CUSTOM, null);
        else apiKey = readSecret(originalRequest.user.directories, SECRET_KEYS.OPENAI, null);
    }
    const headers = new Headers({ 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey ?? ''}` });
    if (!isText) mergeYamlIntoHeaders(headers, String(request.custom_include_headers ?? ''));
    const body = isText ? textProviderBody(request) : {
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        max_completion_tokens: request.max_completion_tokens,
        stream: true,
        presence_penalty: request.presence_penalty,
        frequency_penalty: request.frequency_penalty,
        top_p: request.top_p,
        stop: request.stop,
    };
    if (!isText) {
        mergeYamlIntoObject(body, String(request.custom_include_body ?? ''));
        excludeKeysByYaml(body, String(request.custom_exclude_body ?? ''));
    }
    const endpoint = new URL(url);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new ApiError(422, 'validation', 'Provider URL must use HTTP(S) without embedded credentials.');
    let tokenBudget = null;
    if (acceptedSession) {
        const { auditPrompt } = await import('./prompt.js');
        tokenBudget = await auditPrompt(acceptedSession, { ...request, ...body });
    }
    const secrets = [apiKey, originalRequest.headers?.authorization];
    for (const [key, value] of headers) if (/authorization|api.?key|cookie|token|secret/i.test(key)) secrets.push(value, value.replace(/^Bearer\s+/i, ''));
    const controller = new AbortController();
    const abort = () => controller.abort();
    record.controller.signal.addEventListener('abort', abort, { once: true });
    if (record.controller.signal.aborted) controller.abort();
    const timeout = setTimeout(abort, 300_000);
    timeout.unref?.();
    try {
        if (controller.signal.aborted || isTerminal(record.status)) return { text: record.text, reasoning: record.reasoning, usage: record.usage };
        markProviderDispatched(record);
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
            if (isTerminal(record.status)) return { text: stream.text, reasoning: stream.reasoning, usage: stream.usage };
            bytes += chunk.length;
            if (bytes > 16_777_216) {
                response.body.destroy();
                throw new ApiError(502, 'unknown', 'Provider stream exceeded its size limit; the generation outcome is unknown.');
            }
            stream.push(decoder.decode(chunk, { stream: true }));
        }
        stream.push(decoder.decode(), true);
        if (!stream.completed) throw new ApiError(502, 'unknown', 'Provider stream ended without a completion marker. Partial text was not saved; the generation may have been billed.');
        if (stream.toolCalls.length && stream.finishReason && stream.finishReason !== 'tool_calls') throw new ApiError(502, 'unknown', 'Provider did not finish its tool calls; the generation outcome is unknown.');
        const toolCalls = stream.validatedToolCalls();
        if (toolCalls.length) {
            const redacted = toolCalls.map(call => ({
                id: redactProviderText(call.id, secrets),
                name: redactProviderText(call.function.name, secrets),
                arguments: JSON.stringify(redactToolValue(publicConfiguration(JSON.parse(call.function.arguments)), secrets)),
            }));
            setToolCalls(record, redacted);
            throw new ApiError(422, 'unsupported', 'Provider requested tool execution, but the native tool authorization lifecycle is not configured.');
        }
        if (!stream.text) throw new ApiError(502, 'provider', 'Provider completed without text. The request may have been billed.');
        return { text: stream.text, reasoning: stream.reasoning, usage: stream.usage, tokenBudget };
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

function redactToolValue(value, secrets) {
    if (typeof value === 'string') return redactProviderText(value, secrets);
    if (Array.isArray(value)) return value.map(item => redactToolValue(item, secrets));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactProviderText(key, secrets), redactToolValue(item, secrets)]));
    }
    return value;
}

/** Incremental bounded SSE decoder. A socket EOF alone is never success. */
export class ProviderSseDecoder {
    constructor(record, secrets = []) {
        this.record = record;
        this.secrets = secrets;
        this.buffer = '';
        this.usage = null;
        this.text = '';
        this.reasoning = '';
        this.completed = false;
        this.done = false;
        this.finishReason = null;
        this.outputBytes = 0;
        this.toolCalls = [];
        this.toolBytes = 0;
    }

    validatedToolCalls() {
        const ids = new Set();
        for (let index = 0; index < this.toolCalls.length; index++) {
            const call = this.toolCalls[index];
            let argumentsObject;
            try { argumentsObject = JSON.parse(call?.function.arguments); } catch { /* reported below */ }
            if (!call?.id || ids.has(call.id) || !call.function.name || !argumentsObject || typeof argumentsObject !== 'object' || Array.isArray(argumentsObject)) {
                throw new ApiError(502, 'unknown', 'Provider returned incomplete or invalid tool calls; the generation outcome is unknown.');
            }
            ids.add(call.id);
        }
        return this.toolCalls;
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
            if (json.usage && typeof json.usage === 'object' && !Array.isArray(json.usage)) {
                const next = publicUsage(json.usage);
                const previous = this.usage ?? {};
                this.usage = { ...previous, ...next };
                for (const key of ['prompt_tokens_details', 'completion_tokens_details']) if (previous[key] || next[key]) this.usage[key] = { ...(previous[key] ?? {}), ...(next[key] ?? {}) };
                setUsage(this.record, this.usage);
            }
            const choice = json.choices?.find?.(item => item.index === 0) ?? json.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta ?? choice.message ?? choice;
            const content = extractText(delta.content ?? choice.text);
            const reasoning = extractText(delta.reasoning_content ?? delta.reasoning ?? choice.reasoning);
            if (this.finishReason && (content || reasoning || delta.tool_calls?.length || delta.function_call)) {
                throw new ApiError(502, 'unknown', 'Provider sent output after its completion reason; the generation outcome is unknown.');
            }
            this.outputBytes += Buffer.byteLength(content) + Buffer.byteLength(reasoning);
            if (this.outputBytes > 8_388_608) throw new ApiError(502, 'unknown', 'Provider output exceeded its size limit; the generation outcome is unknown.');
            this.reasoning += reasoning;
            this.text += content;
            appendToken(this.record, reasoning, true);
            appendToken(this.record, content);
            if (delta.function_call || choice.finish_reason === 'function_call') throw new ApiError(422, 'unsupported', 'Provider requested legacy function execution, but the native tool authorization lifecycle is not configured.');
            if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
                if (!Array.isArray(delta.tool_calls)) throw new ApiError(502, 'unknown', 'Provider returned malformed tool calls; the generation outcome is unknown.');
                for (const part of delta.tool_calls) {
                    const invalidPart = !part || !Number.isInteger(part.index) || part.index < 0 || part.index >= 128
                        || (part.type != null && part.type !== 'function') || (part.id != null && typeof part.id !== 'string')
                        || (part.function != null && (typeof part.function !== 'object' || Array.isArray(part.function)))
                        || (part.function?.name != null && typeof part.function.name !== 'string')
                        || (part.function?.arguments != null && typeof part.function.arguments !== 'string');
                    if (invalidPart) throw new ApiError(502, 'unknown', 'Provider returned malformed tool calls; the generation outcome is unknown.');
                    const call = this.toolCalls[part.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
                    const id = part.id ?? '', name = part.function?.name ?? '', args = part.function?.arguments ?? '';
                    this.toolBytes += Buffer.byteLength(id) + Buffer.byteLength(name) + Buffer.byteLength(args);
                    if (this.toolBytes > 1_048_576) throw new ApiError(502, 'unknown', 'Provider tool calls exceeded their size limit; the generation outcome is unknown.');
                    call.id += id;
                    call.function.name += name;
                    call.function.arguments += args;
                }
            }
            if (choice.finish_reason) {
                if (!['stop', 'length', 'content_filter', 'tool_calls'].includes(choice.finish_reason)) throw new ApiError(502, 'unknown', 'Provider returned an unrecognized completion reason.');
                if (choice.finish_reason === 'tool_calls' && !this.toolCalls.length) throw new ApiError(502, 'unknown', 'Provider returned an empty tool-call completion; the generation outcome is unknown.');
                if (this.finishReason && this.finishReason !== choice.finish_reason) throw new ApiError(502, 'unknown', 'Provider returned conflicting completion reasons; the generation outcome is unknown.');
                this.finishReason = choice.finish_reason;
                this.completed = true;
            }
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
