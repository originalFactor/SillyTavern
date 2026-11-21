import { getStringHash, escapeRegex } from '../macro-runtime/generated/utils.js';
import { ApiError } from '../contract.js';
export { getStringHash, escapeRegex };
export let world_info, selected_world_info, world_info_depth, world_info_min_activations, world_info_min_activations_depth_max;
export let world_info_budget, world_info_include_names, world_info_recursive, world_info_overflow_alert, world_info_case_sensitive;
export let world_info_match_whole_words, world_info_use_group_scoring, world_info_character_strategy, world_info_budget_cap, world_info_max_recursion_steps;
export let chat_metadata, characters, this_chid, power_user, extension_settings, shouldWIAddPrompt, extension_prompts;
export const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const MAX_INJECTION_DEPTH = 10000;
export const setShouldWIAddPrompt = value => { shouldWIAddPrompt = value; };
export const $ = selector => ({ val: () => selector === '#extension_floating_prompt' ? chat_metadata.note_prompt ?? '' : '', text() {} });
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
export const NOTE_MODULE_NAME = '2_floating_prompt';
export const metadata_keys = { prompt: 'note_prompt', interval: 'note_interval', depth: 'note_depth', position: 'note_position', role: 'note_role' };
let frame;
export const diagnosticConsole = {
    debug() {}, log() {},
    warn(message) { if (frame && frame.diagnostics.length < 32) frame.diagnostics.push(String(message).slice(0, 500)); },
    error() { diagnosticConsole.warn('World Info evaluator reported an invalid setting.'); },
};
export const toastr = { warning: message => diagnosticConsole.warn(message) };
export const event_types = { WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded', WORLDINFO_SCAN_DONE: 'worldinfo_scan_done' };
export const eventSource = { async emit(type) { if (type === event_types.WORLDINFO_SCAN_DONE && ++frame.loops > 2000) throw new ApiError(422, 'validation', 'World Info recursion limit exceeded.'); } };
export const Math = Object.create(globalThis.Math);
Math.random = () => frame?.random ? frame.random() : globalThis.Math.random();
export const getContext = () => ({
    characterId: 0, chat: frame.context.frame.chat,
    extensionPrompts: frame.context.frame.extensionPrompts, tagMap: frame.tagMap,
    setExtensionPrompt: (key, value, position, depth, scan, role) => { frame.context.frame.extensionPrompts[key] = { value, position, depth, scan, role }; },
});
export const setExtensionPrompt = (...args) => getContext().setExtensionPrompt(...args);
export const getCharaFilename = () => String(frame.characterId || '');
export const getTagKeyForEntity = () => frame.context.frame.characters[0]?.avatar;
export const loadWorldInfo = async name => {
    const value = frame.books[name];
    if (!value) throw new Error('Selected World Info book is missing.');
    return structuredClone(value);
};
export const getExtensionPromptByName = async name => frame.context.expand(frame.context.frame.extensionPrompts[name]?.value ?? '');
export const substituteParams = (text, options) => frame.context.expand(text, options);
export const substituteParamsExtended = (text, additionalMacros, postProcessFn) => frame.context.expand(text, { dynamicMacros: additionalMacros, postProcessFn });
let applyRegex;
export const getRegexedString = (...args) => frame.context.run(() => applyRegex(...args));
export const regex_placement = { MD_DISPLAY: 0, USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 };
export const getPresetManager = () => ({ apiId: 'openai', getSelectedPresetName: () => frame.presetName ?? '', readPresetExtensionField: () => frame.presetRegex ?? [] });
export async function getTokenCountAsync(text) {
    if (!text) return 0;
    const { countOpenAITokens } = await import('../../endpoints/tokenizers.js');
    return countOpenAITokens([{ content: text }], frame.context.frame.model, { strict: true });
}
export function configure(value, regexFunction) {
    frame = value; applyRegex = regexFunction;
    const config = value.settings ?? {};
    world_info = config.world_info ?? {};
    selected_world_info = Array.isArray(world_info.globalSelect) ? world_info.globalSelect : [];
    world_info_depth = Number(config.world_info_depth ?? 2);
    world_info_min_activations = Number(config.world_info_min_activations ?? 0);
    world_info_min_activations_depth_max = Number(config.world_info_min_activations_depth_max ?? 0);
    world_info_budget = Number(config.world_info_budget ?? 25);
    world_info_include_names = config.world_info_include_names !== false;
    world_info_recursive = !!config.world_info_recursive;
    world_info_overflow_alert = !!config.world_info_overflow_alert;
    world_info_case_sensitive = !!config.world_info_case_sensitive;
    world_info_match_whole_words = !!config.world_info_match_whole_words;
    world_info_use_group_scoring = !!config.world_info_use_group_scoring;
    world_info_character_strategy = Number(config.world_info_character_strategy ?? 1);
    world_info_budget_cap = Number(config.world_info_budget_cap ?? 0);
    world_info_max_recursion_steps = Number(config.world_info_max_recursion_steps ?? 0);
    chat_metadata = value.context.frame.metadata;
    characters = value.context.frame.characters; this_chid = 0;
    power_user = value.context.frame.powerUser;
    extension_settings = value.extensionSettings;
    extension_prompts = value.context.frame.extensionPrompts;
    shouldWIAddPrompt = false;
}
