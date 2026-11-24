import yaml from 'yaml';

import { createSession } from './session.js';
import { publicConfiguration, redactProviderText } from './redaction.js';
import { ApiError } from './contract.js';
import { appendToken, isTerminal, markProviderDispatched, setToolCalls, setUsage, shouldStopGeneration } from './generation-store.js';

// Credentials are deliberately outside the serializable session, prompt and
// journal. A worker keeps the exact connection authorized at admission.
const acceptedConnections = new WeakMap<object, any>();

export async function prepareProviderSession(request: any) {
    const { readSecret, SECRET_KEYS } = await import('../endpoints/secrets.js');
    // No await between reading settings and the matching credential value.
    const session = createSession(request);
    const source = String(session.settings.oai_settings?.chat_completion_source ?? 'openai');
    if (session.settings.main_api !== 'openai' || source !== 'openai') throw new ApiError(422, 'unsupported', 'Only the OpenAI Chat Completions provider is supported by this headless backend.');
    const key = readSecret(session.directories, SECRET_KEYS.OPENAI, null);
    acceptedConnections.set(session, { format: 'chat-completions', source, key, url: '' });
    return session;
}

export async function runSessionCompletion(request: any, providerRequest: any, record: any, session: any, clientTools = []) {
    const connection: any = acceptedConnections.get(session);
    const requestSource = String(providerRequest.chat_completion_source ?? 'openai');
    const format = providerRequest.provider_format ?? 'chat-completions';
    if (requestSource !== 'openai' || format !== 'chat-completions') throw new ApiError(422, 'unsupported', 'Only OpenAI Chat Completions is supported by this headless backend.');
    if (connection && (connection.format !== format || connection.source !== requestSource)) throw new ApiError(409, 'conflict', 'The accepted provider connection changed inside the generation.');
    return runChatCompletion(request, providerRequest, record, connection, session, clientTools);
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
export async function runChatCompletion(originalRequest: import('express').Request, providerRequest: Record<string, any>, record: import('./generation-store.js').GenerationRecord, acceptedConnection: any = null, acceptedSession: any = null, clientTools: any[] = []) {
    const { default: fetch, Headers } = await import('node-fetch');
    const { readSecret, SECRET_KEYS } = await import('../endpoints/secrets.js');
    const request = structuredClone(providerRequest);
    const source = String(request.chat_completion_source ?? 'openai');
    if (source !== 'openai' || (request.provider_format && request.provider_format !== 'chat-completions')) throw new ApiError(422, 'unsupported', 'Only OpenAI Chat Completions is supported by this headless backend.');
    const apiKey = acceptedConnection?.key ?? readSecret(originalRequest.user.directories, SECRET_KEYS.OPENAI, null);
    const url = 'https://api.openai.com/v1/chat/completions';
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.set('Authorization', `Bearer ${apiKey ?? ''}`);
    const body: Record<string, any> = {
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
    {
        if (clientTools.length) {
            body.messages = request.messages;
            body.tools = clientTools;
            body.tool_choice = 'auto';
            delete body.functions;
            delete body.function_call;
        }
    }
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
                    if (bytes > 8192) { detail = detail.slice(0, 8192) + ' [truncated]'; (response.body as any).destroy(); break; }
                }
            } catch { detail ||= 'Provider error details unavailable.'; } finally { clearTimeout(detailTimeout); }
            const safe = redactProviderText(detail, secrets);
            console.warn('[api-v1]', record.requestId, 'provider_error', response.status);
            throw new ApiError(502, 'provider', `HTTP ${response.status}: ${safe || 'Provider rejected the request.'}`, { retryable: false });
        }
        if (!response.body) throw new ApiError(502, 'unknown', 'Provider returned no response body; the generation outcome is unknown. Do not replay automatically.');
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().includes('text/event-stream')) {
            (response.body as any).destroy();
            throw new ApiError(502, 'unknown', 'Provider did not return an SSE stream; the generation outcome is unknown.');
        }
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const stream = new ProviderSseDecoder(record, secrets);
        let bytes = 0;
        const responseStream = response.body as unknown as NodeJS.ReadableStream & AsyncIterable<Buffer> & { destroy(): void };
        for await (const chunk of responseStream) {
            if (isTerminal(record.status)) return { text: stream.text, reasoning: stream.reasoning, usage: stream.usage };
            bytes += chunk.length;
            if (bytes > 16_777_216) {
                responseStream.destroy();
                throw new ApiError(502, 'unknown', 'Provider stream exceeded its size limit; the generation outcome is unknown.');
            }
            stream.push(decoder.decode(chunk, { stream: true }));
            if (shouldStopGeneration(record)) return { text: stream.text, reasoning: stream.reasoning, usage: stream.usage };
        }
        stream.push(decoder.decode(), true);
        if (shouldStopGeneration(record)) return { text: stream.text, reasoning: stream.reasoning, usage: stream.usage };
        if (!stream.completed) throw new ApiError(502, 'unknown', 'Provider stream ended without a completion marker. Partial text was not saved; the generation may have been billed.');
        const openAiStream = stream as ProviderSseDecoder;
        if (openAiStream && openAiStream.toolCalls.length && openAiStream.finishReason && openAiStream.finishReason !== 'tool_calls') {
            throw new ApiError(502, 'unknown', 'Provider did not finish its tool calls; the generation outcome is unknown.');
        }
        const toolCalls: any[] = openAiStream ? openAiStream.validatedToolCalls() : [];
        if (toolCalls.length) {
            const redacted = toolCalls.map((call: any) => ({
                id: redactProviderText(call.id, secrets),
                name: redactProviderText(call.function.name, secrets),
                arguments: JSON.stringify(redactToolValue(publicConfiguration(JSON.parse(call.function.arguments)), secrets)),
            }));
            setToolCalls(record, redacted);
            if (clientTools.length) {
                const names = new Set(clientTools.map(tool => tool.function.name));
                if (toolCalls.some((call: any) => !names.has(call.function.name)) || JSON.stringify(redacted) !== JSON.stringify(toolCalls.map((call: any) => ({ id: call.id, name: call.function.name, arguments: JSON.stringify(JSON.parse(call.function.arguments)) })))) {
                    throw new ApiError(422, 'unsupported', 'The provider requested an unavailable tool or credential-bearing arguments. Inspect the redacted proposals.');
                }
                return { text: stream.text, reasoning: stream.reasoning, usage: stream.usage,
                    toolCalls, protectToolResult: (value: any) => redactProviderText(value, secrets) };
            }
            throw new ApiError(422, 'unsupported', 'Provider requested tool execution, but the native tool authorization lifecycle is not configured.');
        }
        if (!stream.text) throw new ApiError(502, 'provider', 'Provider completed without text. The request may have been billed.');
        return { text: stream.text, reasoning: stream.reasoning, usage: stream.usage };
    } catch (error: any) {
        if (error instanceof ApiError) throw error;
        // A transport failure after dispatch cannot prove that the provider did
        // not execute the request. Never turn this into a replayable failure.
        throw new ApiError(502, 'unknown', `Provider connection failed; the generation outcome is unknown and may have been billed. ${redactProviderText(error?.type ?? 'transport_error', secrets)}`);
    } finally {
        clearTimeout(timeout);
        record.controller.signal.removeEventListener('abort', abort);
    }
}

function redactToolValue(value: any, secrets: any): any {
    if (typeof value === 'string') return redactProviderText(value, secrets);
    if (Array.isArray(value)) return value.map((item: any) => redactToolValue(item, secrets));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]): any  => [redactProviderText(key, secrets), redactToolValue(item, secrets)]));
    }
    return value;
}

/** Incremental bounded SSE decoder. A socket EOF alone is never success. */
export class ProviderSseDecoder {
    record: import('./generation-store.js').GenerationRecord;
    secrets: Array<string | null | undefined>;
    buffer: string;
    usage: Record<string, number> | null;
    text: string;
    reasoning: string;
    completed: boolean;
    done: boolean;
    finishReason: string | null;
    outputBytes: number;
    toolCalls: any[];
    toolBytes: number;
    constructor(record: import('./generation-store.js').GenerationRecord, secrets: Array<string | null | undefined> = []) {
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

    validatedToolCalls(): any[] {
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

    push(text: any, flush = false) {
        this.buffer += text;
        const events = this.buffer.split(/\r\n\r\n|\n\n|\r\r/);
        this.buffer = events.pop() ?? '';
        if (flush && this.buffer.trim()) { events.push(this.buffer); this.buffer = ''; }
        if (this.buffer.length > 1_048_576 || events.some((event: any) => event.length > 1_048_576)) throw new ApiError(502, 'unknown', 'Provider SSE event exceeded its size limit; the generation outcome is unknown.');
        for (const event of events) {
            if (shouldStopGeneration(this.record)) return;
            const data = event.split(/\r\n|\r|\n/).filter((line: any) => line.startsWith('data:')).map((line: any) => line.slice(5).trimStart()).join('\n');
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
                const next: Record<string, any> = publicUsage(json.usage) ?? {};
                const previous: Record<string, any> = this.usage ?? {};
                this.usage = { ...previous, ...next };
                for (const key of ['prompt_tokens_details', 'completion_tokens_details']) if (previous[key] || next[key]) this.usage[key] = { ...(previous[key] ?? {}), ...(next[key] ?? {}) };
                setUsage(this.record, this.usage);
            }
            const choice = json.choices?.find?.((item: any) => item.index === 0) ?? json.choices?.[0];
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
            if (shouldStopGeneration(this.record)) return;
            appendToken(this.record, content);
            if (shouldStopGeneration(this.record)) return;
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

function publicUsage(usage: any) {
    // Usage is numeric metadata, never an arbitrary echo of provider fields.
    const clean: Record<string, any> = {};
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
function extractText(value: unknown) {
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
function tryParseJson(text: string) {
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
function mergeYamlIntoHeaders(target: any, value: string) {
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
function mergeYamlIntoObject(target: Record<string, any>, value: string) {
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
function excludeKeysByYaml(target: Record<string, any>, value: string) {
    if (!value) return;
    try {
        const parsed = yaml.parse(value);
        if (Array.isArray(parsed)) for (const key of parsed) delete target[String(key)];
    } catch {
        // Ignore invalid optional YAML, matching the existing provider route.
    }
}
