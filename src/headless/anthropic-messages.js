import { ApiError } from './contract.js';
import { appendToken, setUsage } from './generation-store.js';

const MAX_OUTPUT_BYTES = 8_388_608;
const MAX_EVENT_BYTES = 1_048_576;
const VALID_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal']);

/** Convert the native Chat Completion message envelope to the Anthropic Messages wire format. */
export function anthropicMessagesBody(request, clientTools = []) {
    if (!Array.isArray(request.messages)) throw new ApiError(422, 'validation', 'Claude Messages requires an ordered message array.');
    const system = [];
    const messages = [];
    for (const message of request.messages) {
        const content = typeof message?.content === 'string' ? message.content : '';
        if (!content) throw new ApiError(422, 'validation', 'Claude Messages supports text-only prompt rows.');
        if (message.role === 'system') { system.push(content); continue; }
        if (!['user', 'assistant'].includes(message.role)) throw new ApiError(422, 'validation', 'Claude Messages supports only system, user and assistant rows.');
        const previous = messages.at(-1);
        if (previous?.role === message.role) previous.content += `\n\n${content}`;
        else messages.push({ role: message.role, content });
    }
    if (!messages.length) throw new ApiError(422, 'validation', 'Claude Messages requires at least one user or assistant row.');
    if (clientTools.length) throw new ApiError(422, 'unsupported', 'Native tool execution is unavailable for Claude Messages.');
    const body = {
        model: String(request.model ?? ''),
        messages,
        max_tokens: Number(request.max_tokens ?? 300),
        stream: true,
        temperature: Math.min(Number(request.temperature ?? 1), 1),
        top_p: Number(request.top_p ?? 1),
    };
    if (system.length) body.system = system.join('\n\n');
    if (Array.isArray(request.stop) && request.stop.length) body.stop_sequences = request.stop.slice(0, 4).map(String);
    if (!body.model || !Number.isInteger(body.max_tokens) || body.max_tokens <= 0) throw new ApiError(422, 'validation', 'Claude Messages requires a model and positive max_tokens.');
    return body;
}

function numericUsage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const clean = {};
    for (const [key, count] of Object.entries(value)) {
        if (typeof count === 'number' && Number.isFinite(count) && count >= 0) clean[key] = count;
    }
    return Object.keys(clean).length ? clean : null;
}

/** Incremental bounded Anthropic Messages SSE decoder. A socket EOF alone is never success. */
export class AnthropicSseDecoder {
    constructor(record, secrets = []) {
        this.record = record;
        this.secrets = secrets;
        this.buffer = '';
        this.text = '';
        this.reasoning = '';
        this.usage = null;
        this.completed = false;
        this.done = false;
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
            const lines = event.split(/\r\n|\r|\n/);
            const name = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? '';
            const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            if (this.done) throw new ApiError(502, 'unknown', 'Provider sent data after its completion marker.');
            const json = (() => { try { return JSON.parse(data); } catch { return null; } })();
            if (!json || typeof json !== 'object') throw new ApiError(502, 'unknown', 'Provider returned malformed SSE data; the generation outcome is unknown.');
            if (json.type === 'error' || (name === 'error' && json.error)) {
                const detail = String(json.error?.message ?? 'Provider stream error.');
                throw new ApiError(502, 'provider', `Provider stream error: ${detail}`);
            }
            if (json.type === 'message_start' && json.message?.usage) this.applyUsage(json.message.usage);
            if (json.type === 'message_delta') {
                if (json.usage) this.applyUsage(json.usage);
                const reason = json.delta?.stop_reason;
                if (typeof reason === 'string' && reason) {
                    if (!VALID_STOP_REASONS.has(reason)) throw new ApiError(502, 'unknown', 'Provider returned an unrecognized completion reason.');
                    if (this.finishReason && this.finishReason !== reason) throw new ApiError(502, 'unknown', 'Provider returned conflicting completion reasons; the generation outcome is unknown.');
                    this.finishReason = reason;
                    this.completed = true;
                }
            }
            if (json.type === 'content_block_delta' && this.finishReason) {
                throw new ApiError(502, 'unknown', 'Provider sent output after its completion reason; the generation outcome is unknown.');
            }
            if (json.type === 'content_block_delta') {
                const delta = json.delta ?? {};
                if (delta.type === 'text_delta') this.append(delta.text ?? '', false);
                else if (delta.type === 'thinking_delta') this.append(delta.thinking ?? '', true);
                else if (delta.type === 'input_json_delta') throw new ApiError(422, 'unsupported', 'Claude tool execution is unavailable; inspect the retained generation.');
                else if (!['signature_delta'].includes(delta.type)) throw new ApiError(502, 'unknown', 'Provider returned an unknown content delta; the generation outcome is unknown.');
            }
            if (json.type === 'message_stop') this.done = true;
        }
    }

    applyUsage(usage) {
        const clean = numericUsage(usage);
        if (!clean) return;
        this.usage = { ...(this.usage ?? {}), ...clean };
        setUsage(this.record, this.usage);
    }

    append(value, isReasoning) {
        if (typeof value !== 'string' || !value) return;
        this.outputBytes += Buffer.byteLength(value);
        if (this.outputBytes > MAX_OUTPUT_BYTES) throw new ApiError(502, 'unknown', 'Provider output exceeded its size limit; the generation outcome is unknown.');
        if (isReasoning) this.reasoning += value; else this.text += value;
        appendToken(this.record, value, isReasoning);
    }
}
