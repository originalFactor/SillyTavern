import { ApiError } from './contract.js';
import { OPENAI_KEYS, VLLM_KEYS } from '../constants.js';
import { trimV1 } from '../util.js';
import { getTextGenModel } from './text-runtime/generated/models.js';

/** Specific proven wire formats; this is not the full upstream provider list. */
export const TEXT_COMPLETION_SOURCES = Object.freeze({
    generic: 'GENERIC', vllm: 'VLLM', ooba: 'OOBA', aphrodite: 'APHRODITE', tabby: 'TABBY', koboldcpp: 'KOBOLDCPP',
});
export function textProviderConnection(settings) {
    const text = settings.textgenerationwebui_settings ?? {};
    const source = String(text.type ?? 'ooba');
    if (!Object.hasOwn(TEXT_COMPLETION_SOURCES, source)) throw new ApiError(422, 'unsupported', 'This native text-completion provider format is not connected.');
    let endpoint;
    try { endpoint = new URL(String(text.server_urls?.[source] ?? '')); } catch { throw new ApiError(422, 'validation', 'Configure a valid text-completion server URL.'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new ApiError(422, 'validation', 'Text-completion URL requires HTTP(S) without credentials, query or fragment.');
    const base = trimV1(endpoint.href.replace(/\/$/, ''));
    return { format: 'text-completions', source, url: `${base}/v1/completions`, secretName: TEXT_COMPLETION_SOURCES[source] };
}
export function buildTextProviderRequest(session, overrides = {}) {
    const connection = textProviderConnection(session.settings);
    const model = overrides.model ?? getTextGenModel(session.settings.textgenerationwebui_settings ?? {});
    if (['generic', 'vllm', 'aphrodite'].includes(connection.source) && !model) throw new ApiError(422, 'validation', 'No text-completion model is configured.');
    return { provider_format: connection.format, api_type: connection.source, api_server: connection.url, model };
}
/** Apply the same generic/vLLM key filters as the browser's server adapter. */
export function textProviderBody(request) {
    if (!Object.hasOwn(TEXT_COMPLETION_SOURCES, request.api_type)) throw new ApiError(422, 'unsupported', 'This text provider is not connected.');
    if (typeof request.prompt !== 'string' || !request.prompt.length) throw new ApiError(422, 'validation', 'Text-completion prompt must be a nonempty string.');
    if (request.n !== undefined && request.n !== 1) throw new ApiError(422, 'unsupported', 'Multiple simultaneous text-completion choices need the native alternative lifecycle.');
    const keys = request.api_type === 'generic' ? OPENAI_KEYS : request.api_type === 'vllm' ? VLLM_KEYS : null;
    if (keys && ((request.guidance_scale !== undefined && request.guidance_scale !== 1) || request.negative_prompt)) throw new ApiError(422, 'unsupported', 'This text format does not support CFG/negative-prompt parameters.');
    const body = Object.fromEntries(Object.entries(request).filter(([key]) => !['provider_format', 'api_type', 'api_server', 'messages'].includes(key) && (!keys || keys.includes(key))));
    if (request.api_type === 'generic' && Array.isArray(body.stop)) body.stop = body.stop.slice(0, 4);
    body.stream = true;
    return body;
}
