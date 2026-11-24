import { getStringHash, escapeRegex } from '../macro-runtime/compat/utils.js';
import { ApiError } from '../contract.js';
export { getStringHash, escapeRegex };
export let world_info: any, selected_world_info: any, world_info_depth: any, world_info_min_activations: any, world_info_min_activations_depth_max: any;
export let world_info_include_names: any, world_info_recursive: any, world_info_case_sensitive: any;
export let world_info_match_whole_words: any, world_info_use_group_scoring: any, world_info_character_strategy: any, world_info_max_recursion_steps: any;
export let chat_metadata: any, characters: any, this_chid: any, power_user: any, extension_settings: any, shouldWIAddPrompt: any, extension_prompts: any;
export const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const MAX_INJECTION_DEPTH = 10000;
export const setShouldWIAddPrompt = (value: any) => { shouldWIAddPrompt = value; };
export const $ = (selector: any) => ({ val: () => selector === '#extension_floating_prompt' ? chat_metadata.note_prompt ?? '' : '', text() {} });
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
export const NOTE_MODULE_NAME = '2_floating_prompt';
export const metadata_keys = { prompt: 'note_prompt', interval: 'note_interval', depth: 'note_depth', position: 'note_position', role: 'note_role' };
let frame: any;
export const diagnosticConsole = {
    debug() {}, log() {},
    warn(message: any) { if (frame && frame.diagnostics.length < 32) frame.diagnostics.push(String(message).slice(0, 500)); },
    error() { diagnosticConsole.warn(frame?.diagnosticLabel ?? 'World Info evaluator reported an invalid setting.'); },
};
export const toastr = { warning: (message: any) => diagnosticConsole.warn(message) };
export const event_types = { WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded', WORLDINFO_SCAN_DONE: 'worldinfo_scan_done' };
export const eventSource = { async emit(type: any) { if (type === event_types.WORLDINFO_SCAN_DONE && ++frame.loops > 2000) throw new ApiError(422, 'validation', 'World Info recursion limit exceeded.'); } };
export const Math = Object.create(globalThis.Math);
Math.random = () => frame?.random ? frame.random() : globalThis.Math.random();
export const getContext = () => ({
    characterId: frame.context.frame.characterIndex ?? 0, chat: frame.context.frame.chat,
    extensionPrompts: frame.context.frame.extensionPrompts, tagMap: frame.tagMap,
    setExtensionPrompt: (key: any, value: any, position: any, depth: any, scan: any, role: any) => { frame.context.frame.extensionPrompts[key] = { value, position, depth, scan, role }; },
});
export const setExtensionPrompt = (...args: any[]) => (getContext().setExtensionPrompt as (...items: any[]) => void)(...args);
export const getCharaFilename = () => String(frame.characterId || '');
export const getTagKeyForEntity = () => frame.context.frame.characters[frame.context.frame.characterIndex ?? 0]?.avatar;
export const loadWorldInfo = async (name: any) => {
    const value = frame.books[name];
    if (!value) throw new Error('Selected World Info book is missing.');
    return structuredClone(value);
};
export const getExtensionPromptByName = async (name: any) => frame.context.expand(frame.context.frame.extensionPrompts[name]?.value ?? '');
export const substituteParams = (text: any, options: any) => frame.context.expand(text, options);
export const substituteParamsExtended = (text: any, additionalMacros: any, postProcessFn: any) => frame.context.expand(text, { dynamicMacros: additionalMacros, postProcessFn });
let applyRegex: any;
export const getRegexedString = (...args: any[]) => frame.context.run(() => applyRegex(...args));
export const regex_placement = { MD_DISPLAY: 0, USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 };
export const getPresetManager = () => ({ apiId: frame.context.frame.mainApi || 'openai', getSelectedPresetName: () => frame.presetName ?? '', readPresetExtensionField: () => frame.presetRegex ?? [] });
export function configure(value: any, regexFunction: any) {
    frame = value; applyRegex = regexFunction;
    const config = value.settings ?? {};
    world_info = config.world_info ?? {};
    selected_world_info = Array.isArray(world_info.globalSelect) ? world_info.globalSelect : [];
    world_info_depth = Number(config.world_info_depth ?? 2);
    world_info_min_activations = Number(config.world_info_min_activations ?? 0);
    world_info_min_activations_depth_max = Number(config.world_info_min_activations_depth_max ?? 0);
    world_info_include_names = config.world_info_include_names !== false;
    world_info_recursive = !!config.world_info_recursive;
    world_info_case_sensitive = !!config.world_info_case_sensitive;
    world_info_match_whole_words = !!config.world_info_match_whole_words;
    world_info_use_group_scoring = !!config.world_info_use_group_scoring;
    world_info_character_strategy = Number(config.world_info_character_strategy ?? 1);
    world_info_max_recursion_steps = Number(config.world_info_max_recursion_steps ?? 0);
    chat_metadata = value.context.frame.metadata;
    characters = value.context.frame.characters; this_chid = value.context.frame.characterIndex ?? 0;
    power_user = value.context.frame.powerUser;
    extension_settings = value.extensionSettings;
    extension_prompts = value.context.frame.extensionPrompts;
    shouldWIAddPrompt = false;
}
