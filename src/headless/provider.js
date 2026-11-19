import yaml from 'yaml';

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
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: record.controller.signal,
    });
    if (!response.ok) {
        const detail = (await response.text()).slice(0, 1000);
        console.warn('[api-v1]', record.requestId, 'provider_error', response.status);
        throw new ApiError(502, 'provider', `Chat Completion provider returned ${response.status}.`, {
            retryable: response.status === 429 || response.status >= 500,
            details: detail ? { provider: detail } : undefined,
        });
    }
    if (!response.body) {
        throw new ApiError(502, 'provider', 'Chat Completion provider returned no response body.', { retryable: false });
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;
    for await (const chunk of response.body) {
        if (isTerminal(record.status)) return { text: record.text, reasoning: record.reasoning, usage };
        buffer += decoder.decode(chunk, { stream: true });
        usage = parseSseChunks(record, buffer) ?? usage;
        buffer = record.sseBuffer ?? '';
    }
    if (buffer.trim()) usage = parseSseChunks(record, `${buffer}\n\n`) ?? usage;
    if (record.text.length === 0) {
        throw new ApiError(502, 'provider', 'Chat Completion provider returned no text.', { retryable: false });
    }
    return { text: record.text, reasoning: record.reasoning, usage };
}

/**
 * Parses a chunk of OpenAI-compatible SSE data into generation events.
 * @param {import('./generation-store.js').GenerationRecord} record Generation record
 * @param {string} text Stream chunk
 * @returns {Record<string, any>|null} Usage object if present in this chunk
 */
function parseSseChunks(record, text) {
    let usage = null;
    const events = text.split(/\r\n\r\n|\n\n|\r\r/);
    record.sseBuffer = events.pop() ?? '';
    for (const event of events) {
        const data = event
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
        if (!data || data === '[DONE]') continue;
        const json = tryParseJson(data);
        if (!json) continue;
        if (json.usage && typeof json.usage === 'object') usage = json.usage;
        const choice = json.choices?.[0] ?? {};
        const delta = choice.delta ?? choice.message ?? choice;
        const content = extractText(delta.content ?? choice.text);
        const reasoning = extractText(delta.reasoning_content ?? delta.reasoning ?? choice.reasoning);
        appendToken(record, reasoning, true);
        appendToken(record, content);
    }
    return usage;
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
