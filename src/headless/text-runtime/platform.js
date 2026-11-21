import crypto from 'node:crypto';
import { ApiError } from '../contract.js';
import { parseExampleIntoIndividual as sourceExampleParser } from '../macro-runtime/generated/instruct.js';
export { Handlebars } from '../macro-runtime/platform.js';

export let power_user = {}, extension_prompts = {}, name1 = 'User', name2 = 'Character', main_api = 'textgenerationwebui', nai_settings = {};
export const selected_group = null;
export const IGNORE_SYMBOL = Symbol.for('ignore');
export const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
let frame;
export function configureTextRuntime(value) {
    frame = value; power_user = value.context.frame.powerUser;
    extension_prompts = value.context.frame.extensionPrompts;
    name1 = value.context.frame.userName; name2 = value.context.frame.characterName;
    main_api = value.context.frame.mainApi; nai_settings = value.nai ?? {};
    frame.cache = new Map(); frame.storage = new Map(); frame.warnings ??= [];
}
export const substituteParams = (text, options, name2Override) => frame.context.expand(String(text ?? ''), typeof options === 'string' || options === null ? { name1Override: options, name2Override } : options ?? {});
export const parseExampleIntoIndividual = (...args) => frame.context.run(() => sourceExampleParser(...args));
export const getStringHash = text => crypto.createHash('sha256').update(String(text)).digest('hex');
export const accountStorage = { getItem: key => frame.storage.get(key) ?? null, setItem(key, value) { if (Buffer.byteLength(String(value)) > 1_048_576) throw new ApiError(422, 'validation', 'Story validation cache exceeds its limit.'); frame.storage.set(key, String(value)); } };
export const diagnosticConsole = {
    log() {}, debug() {},
    warn(message) { if (frame.warnings.length < 32) frame.warnings.push(String(message).split('\n', 1)[0].slice(0, 500)); },
    error() { diagnosticConsole.warn('Instruct/context formatting reported an invalid template.'); },
};
export const toastr = { warning: message => diagnosticConsole.warn(message), error: message => diagnosticConsole.warn(message) };
export async function getTokenCountAsync(text, padding = 0) {
    if (typeof text !== 'string' || !text.length) return 0;
    if (!Number.isSafeInteger(padding) || padding < 0) throw new ApiError(422, 'validation', 'Token padding must be a nonnegative integer.');
    if (text.length > 8_388_608) throw new ApiError(422, 'validation', 'String prompt exceeds the native evaluation bound.');
    const key = `${frame.tokenizer}:${padding}:${getStringHash(text)}`;
    if (frame.cache.has(key)) return frame.cache.get(key);
    const { encodeLocalTextTokens } = await import('../../endpoints/tokenizers.js');
    let count;
    try { count = (await encodeLocalTextTokens(text, frame.tokenizer)).length + padding; } catch { throw new ApiError(422, 'unsupported', 'Selected local text tokenizer is unavailable; no guessed count or model request was used.'); }
    if (frame.cache.size >= 10000) frame.cache.delete(frame.cache.keys().next().value);
    frame.cache.set(key, count); return count;
}
