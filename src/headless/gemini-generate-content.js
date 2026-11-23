import { ApiError } from './contract.js';
import { appendToken, setUsage } from './generation-store.js';
import { GEMINI_SAFETY } from '../constants.js';

const MAX_OUTPUT_BYTES = 8_388_608;
const MAX_EVENT_BYTES = 1_048_576;
const VALID_FINISH_REASONS = new Set(['STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'LANGUAGE', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL']);

function validateText(value) {
    if (typeof value !== 'string' || !value) throw new ApiError(422, 'validation', 'Google AI Studio supports text-only prompt rows.');
    return value;
}

/** Convert native Chat Completion text rows to Gemini generateContent contents. */
export function geminiGenerateContentBody(request, clientTools = []) {
    if (!Array.isArray(request.messages)) throw new ApiError(422, 'validation', 'Google AI Studio requires an ordered message array.');
    if (clientTools.length) throw new ApiError(422, 'unsupported', 'Native tool execution is unavailable for Google AI Studio.');
    const system = [];
    const contents = [];
    for (const message of request.messages) {
        const text = validateText(message?.content);
        if (message.role === 'system') { system.push(text); continue; }
        if (!['user', 'assistant'].includes(message.role)) throw new ApiError(422, 'validation', 'Google AI Studio supports only system, user and assistant rows.');
        const role = message.role === 'assistant' ? 'model' : 'user';
        const previous = contents.at(-1);
        if (previous?.role === role) previous.parts.push({ text });
        else contents.push({ role, parts: [{ text }] });
    }
    if (!contents.length) throw new ApiError(422, 'validation', 'Google AI Studio requires at least one user or model row.');
    const maxOutputTokens = Number(request.max_tokens ?? 300);
    if (!String(request.model ?? '') || !Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
        throw new ApiError(422, 'validation', 'Google AI Studio requires a model and positive max_tokens.');
    }
    const generationConfig = {
        candidateCount: 1,
        maxOutputTokens,
        temperature: Number(request.temperature ?? 1),
        topP: Number(request.top_p ?? 1),
    };
    if (Array.isArray(request.stop) && request.stop.length) generationConfig.stopSequences = request.stop.slice(0, 5).map(String);
    const body = { contents, safetySettings: GEMINI_SAFETY, generationConfig };
    if (system.length) body.systemInstruction = { parts: system.map(text => ({ text })) };
    return body;
}

function publicUsage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const clean = {};
    for (const [key, count] of Object.entries(value)) {
        if (typeof count === 'number' && Number.isFinite(count) && count >= 0) clean[key] = count;
    }
    return Object.keys(clean).length ? clean : null;
}

/** Incremental bounded Gemini streamGenerateContent SSE decoder. A socket EOF alone is never success. */
export class GeminiSseDecoder {
    constructor(record, secrets = []) {
        this.record = record;
        this.secrets = secrets;
        this.buffer = '';
        this.text = '';
        this.reasoning = '';
        this.usage = null;
        this.completed = false;
        this.finishReason = null;
        this.outputBytes = 0;
    }

    push(text, flush = false) {
        this.buffer += text;
        const events = this.buffer.split(/\r\n\r\n|\n\n|\r\r/);
        this.buffer = events.pop() ?? '';
        if (flush && this.buffer.trim()) { events.push(this.buffer); this.buffer = ''; }
        if (this.buffer.length > MAX_EVENT_BYTES || events.some(event => event.length > MAX_EVENT_BYTES)) {
            throw new ApiError(502, 'unknown', 'Provider SSE event exceeded its size limit; the generation outcome is unknown.');
        }
        for (const event of events) {
            const data = event.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const json = (() => { try { return JSON.parse(data); } catch { return null; } })();
            if (!json || typeof json !== 'object') throw new ApiError(502, 'unknown', 'Provider returned malformed SSE data; the generation outcome is unknown.');
            if (json.error) {
                const detail = String(json.error.message ?? 'Provider stream error.');
                throw new ApiError(502, 'provider', `Provider stream error: ${detail}`);
            }
            if (this.finishReason) throw new ApiError(502, 'unknown', 'Provider sent data after its completion reason; the generation outcome is unknown.');
            if (json.promptFeedback?.blockReason) throw new ApiError(502, 'provider', `Provider blocked the prompt: ${json.promptFeedback.blockReason}`);
            const usage = publicUsage(json.usageMetadata);
            if (usage) {
                this.usage = { ...(this.usage ?? {}), ...usage };
                setUsage(this.record, this.usage);
            }
            const candidates = Array.isArray(json.candidates) ? json.candidates : [];
            const candidate = candidates[0];
            const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
            for (const part of parts) {
                if (typeof part?.text === 'string' && part.text) this.append(part.text, part.thought === true);
                else if (part?.inlineData || part?.functionCall) throw new ApiError(422, 'unsupported', 'Provider returned native media or tool execution, which is unavailable. Inspect the retained generation.');
            }
            if (candidate?.finishReason) {
                if (!VALID_FINISH_REASONS.has(candidate.finishReason)) throw new ApiError(502, 'unknown', 'Provider returned an unrecognized completion reason.');
                this.finishReason = candidate.finishReason;
                this.completed = true;
            }
        }
    }

    append(value, isReasoning) {
        this.outputBytes += Buffer.byteLength(value);
        if (this.outputBytes > MAX_OUTPUT_BYTES) throw new ApiError(502, 'unknown', 'Provider output exceeded its size limit; the generation outcome is unknown.');
        if (isReasoning) this.reasoning += value; else this.text += value;
        appendToken(this.record, value, isReasoning);
    }
}
