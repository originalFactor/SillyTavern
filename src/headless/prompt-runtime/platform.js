import crypto from 'node:crypto';
import { ApiError } from '../contract.js';
import { TokenHandler } from './generated/engine.js';
import { NativePromptManager } from './generated/manager.js';
import { countTokensOpenAIAsync } from './generated/tokenizers.js';

export let oai_settings = {}, power_user = {}, extension_prompts = {}, promptManager, tokenHandler;
export let main_api = 'openai', name1 = 'User', name2 = 'Character';
export let selected_group = null;
export const IGNORE_SYMBOL = Symbol.for('ignore');
export const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
export const textgen_settings = {}, textgen_types = { OPENROUTER: 'openrouter' }, model_list = [], openRouterModels = [];
let frame;

export function configurePromptRuntime(value) {
    frame = value;
    oai_settings = value.oai;
    power_user = value.context?.frame.powerUser ?? {};
    extension_prompts = value.context?.frame.extensionPrompts ?? {};
    name1 = value.context?.frame.userName ?? 'User'; name2 = value.context?.frame.characterName ?? 'Character';
    selected_group = value.context?.frame.selectedGroup ?? null;
    main_api = 'openai';
    tokenHandler = new TokenHandler(countTokensOpenAIAsync);
    promptManager = new NativePromptManager(oai_settings, tokenHandler);
    frame.cache = new Map();
    frame.tokenCache = new Proxy(Object.create(null), {
        get(_object, key) { return frame.cache.get(key); },
        set(_object, key, value) {
            if (!frame.cache.has(key) && frame.cache.size >= 10000) frame.cache.delete(frame.cache.keys().next().value);
            frame.cache.set(key, value); return true;
        },
    });
    return promptManager;
}
export const getTokenCacheObject = () => frame.tokenCache;
// The cache key is opaque to source semantics; collision-resistant keys avoid
// a crafted different message inheriting another message's token count.
export const getStringHash = text => crypto.createHash('sha256').update(String(text)).digest('hex');
export const getChatCompletionModel = () => frame.context?.frame.model ?? String(oai_settings.chat_completion_source === 'custom' ? oai_settings.custom_model : oai_settings.openai_model);
export const substituteParams = (text, options) => {
    if (!frame.context) throw new ApiError(500, 'internal', 'Macro expansion is unavailable during a token-only audit.');
    return frame.context.expand(text ?? '', options);
};
export const substituteParamsExtended = (text, macros, postProcessFn) => substituteParams(text, { dynamicMacros: macros, postProcessFn });
export const getRegexedString = (...args) => {
    if (!frame.regex) throw new ApiError(500, 'internal', 'Regex evaluation is unavailable during a token-only audit.');
    return frame.regex.apply(...args);
};
export const jQuery = {
    async ajax(options) {
        const url = new URL(options.url, 'http://127.0.0.1');
        if (url.pathname !== '/api/tokenizers/openai/count' || options.type !== 'POST') throw new ApiError(422, 'unsupported', 'This browser transport is not available to native prompt evaluation.');
        process.env.SILLYTAVERN_ENABLEDOWNLOADABLETOKENIZERS = 'false';
        const { countOpenAITokens } = await import('../../endpoints/tokenizers.js');
        try {
            const count = await countOpenAITokens(JSON.parse(options.data), String(url.searchParams.get('model') ?? ''), { strict: true });
            if (!Number.isFinite(count) || count < 0) throw new Error('Invalid tokenizer result');
            return { token_count: count };
        } catch { throw new ApiError(422, 'unsupported', 'The selected tokenizer is unavailable or cannot count this message. No model request was sent.'); }
    },
};
export const ToolManager = {
    // Previously completed invocations can be reconstructed as history. New
    // execution still requires the separate authorization lifecycle.
    isToolCallingSupported: () => oai_settings.function_calling === true,
    canPerformToolCalls: () => false,
    registerFunctionToolsOpenAI() { throw new ApiError(422, 'unsupported', 'Native tool authorization is not configured.'); },
};
export const isImageInliningSupported = () => false;
export const isVideoInliningSupported = () => false;
export const isAudioInliningSupported = () => false;
export const isReasoningSignatureSupported = () => false;
export const isDataURL = value => typeof value === 'string' && value.startsWith('data:');
function mediaUnavailable() { frame.unsupportedMedia = true; throw new ApiError(422, 'unsupported', 'Native media input is not configured; no resource was fetched.'); }
export { mediaUnavailable as fetch, mediaUnavailable as getBase64Async, mediaUnavailable as createThumbnail, mediaUnavailable as getImageSizeFromDataURL, mediaUnavailable as getVideoDurationFromDataURL, mediaUnavailable as getAudioDurationFromDataURL };
export const t = (strings, ...values) => strings.reduce((result, value, index) => result + value + (values[index] ?? ''), '');
export const diagnosticConsole = { log() {}, debug() {}, table() {}, warn() { if (frame?.warnings.length < 32) frame.warnings.push('Prompt assembly reported a non-fatal source diagnostic.'); }, error() { diagnosticConsole.warn(); } };
export const toastr = { error: () => diagnosticConsole.warn(), warning: () => diagnosticConsole.warn() };
export const event_types = { CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready' };
export const eventSource = { async emit() {} };
