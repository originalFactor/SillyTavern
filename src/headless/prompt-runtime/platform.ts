import { ApiError } from '../contract.js';
import { TokenHandler } from './compat/engine.js';
import { NativePromptManager } from './compat/manager.js';

export let oai_settings: Record<string, any> = {}, power_user = {}, extension_prompts = {}, promptManager: any, tokenHandler: any;
export let main_api = 'openai', name1 = 'User', name2 = 'Character';
export let selected_group = null;
export const IGNORE_SYMBOL = Symbol.for('ignore');
export const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
export const textgen_settings: Record<string, any> = {}, textgen_types = { OPENROUTER: 'openrouter' }, model_list: any[] = [], openRouterModels: any[] = [];
let frame: any;
let reasoningOriginModel = '';

export function configurePromptRuntime(value: any) {
    frame = value;
    oai_settings = value.oai;
    const modelBySource: Record<string, any> = {
        custom: oai_settings.custom_model,
    };
    reasoningOriginModel = String(value.reasoningOriginModel ?? modelBySource[oai_settings.chat_completion_source] ?? oai_settings.openai_model ?? '');
    power_user = value.context?.frame.powerUser ?? {};
    extension_prompts = value.context?.frame.extensionPrompts ?? {};
    name1 = value.context?.frame.userName ?? 'User'; name2 = value.context?.frame.characterName ?? 'Character';
    selected_group = value.context?.frame.selectedGroup ?? null;
    main_api = 'openai';
    tokenHandler = new TokenHandler(async () => 0);
    promptManager = new NativePromptManager(oai_settings, tokenHandler);
    return promptManager;
}
export const getChatCompletionModel = () => reasoningOriginModel;
export const substituteParams = (text: any, options: any) => {
    if (!frame.context) throw new ApiError(500, 'internal', 'Macro expansion is unavailable during a token-only audit.');
    return frame.context.expand(text ?? '', options);
};
export const substituteParamsExtended = (text: any, macros: any, postProcessFn: any) => substituteParams(text, { dynamicMacros: macros, postProcessFn });
export const getRegexedString = (...args: any[]) => {
    if (!frame.regex) throw new ApiError(500, 'internal', 'Regex evaluation is unavailable during a token-only audit.');
    return frame.regex.apply(...args);
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
export const isDataURL = (value: any) => typeof value === 'string' && value.startsWith('data:');
function mediaUnavailable() { frame.unsupportedMedia = true; throw new ApiError(422, 'unsupported', 'Native media input is not configured; no resource was fetched.'); }
export { mediaUnavailable as fetch, mediaUnavailable as getBase64Async, mediaUnavailable as createThumbnail, mediaUnavailable as getImageSizeFromDataURL, mediaUnavailable as getVideoDurationFromDataURL, mediaUnavailable as getAudioDurationFromDataURL };
export const t = (strings: any, ...values: any[]) => strings.reduce((result: any, value: any, index: any) => result + value + (values[index] ?? ''), '');
export const diagnosticConsole = { log() {}, debug() {}, table() {}, warn() { if (frame?.warnings.length < 32) frame.warnings.push('Prompt assembly reported a non-fatal source diagnostic.'); }, error() { diagnosticConsole.warn(); } };
export const toastr = { error: () => diagnosticConsole.warn(), warning: () => diagnosticConsole.warn() };
export const event_types = { CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready' };
export const eventSource = { async emit() {} };
