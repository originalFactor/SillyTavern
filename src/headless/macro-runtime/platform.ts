import crypto from 'node:crypto';
import * as chevrotain from 'chevrotain';
import Handlebars from 'handlebars';
import moment from 'moment';
import seedrandom from 'seedrandom';
import rawDroll from 'droll';

export { crypto, chevrotain, Handlebars, moment, seedrandom };
export const droll = {
    validate: (formula: any) => {
        const parsed = rawDroll.parse(formula);
        if (parsed && (!Number.isSafeInteger(parsed.numDice) || parsed.numDice > 10000 || !Number.isSafeInteger(parsed.maxResult))) {
            if (frame) frame.limitExceeded = true;
            return false;
        }
        return rawDroll.validate(formula);
    },
    roll: (formula: any) => rawDroll.roll(formula),
};
let hooks: Record<string, any> = {};
let frame: any = null;
export let MacroEngine: any, MacroEnvBuilder: any;
export let chat: any[] = [], chat_metadata: Record<string, any> = {}, main_api = 'openai', power_user: Record<string, any> = { experimental_macro_engine: false, instruct: {}, context: {}, sysprompt: {} };
export let oai_settings: Record<string, any> = {}, max_context = 4096, amount_gen = 300, nai_settings: Record<string, any> = {};
export let characters: any[] = [], this_chid = 0, selected_group = null, groups: any[] = [], name1 = 'User', name2 = 'Character';
export let extension_settings = { variables: { global: {} } }, extension_prompts = {}, textgenerationwebui_banned_in_macros: any[] = [];
export const inject_ids = { CUSTOM_WI_OUTLET: (key: any) => `customWIOutlet_${key}` };
export const accountStorage = { getItem: () => 'true' };
export const onboardingExperimentalMacroEngine = async () => {};
export class SlashCommandClosure {}

function warn(value: Record<string, any> = {}) {
    if (!frame) return;
    if (frame.warnings.length >= 32) return;
    // Do not log expressions, variable values, settings or stack payloads.
    frame.warnings.push(String(value.message ?? 'Macro syntax warning').slice(0, 500));
}
export const macroConsole = { log: () => {}, warn: (...args: any[]) => warn({ message: args.filter(item => typeof item === 'string').join(' ') }), error: (...args: any[]) => warn({ message: args[0] }), trace: () => {} };
export const logMacroRuntimeWarning = warn, logMacroInternalError = warn, logMacroRegisterWarning = warn, logMacroRegisterError = warn, logMacroGeneralError = warn;
export function logMacroSyntaxWarning({ phase, errors }: any) { if (errors?.length) warn({ message: `Macro ${phase} reported ${errors.length} issue(s).` }); }
export function createMacroRuntimeError({ message, macroName, call, def }: any) {
    return Object.assign(new Error(message), { name: 'MacroRuntimeError', isMacroRuntimeError: true, macroName: macroName ?? call?.name ?? def?.name });
}
export function installRuntime(value: any) { hooks = value; MacroEngine = value.engine; MacroEnvBuilder = value.envBuilder; }
const delegate = (name: any) => (...args: any[]) => hooks.utils[name](...args);
export const getStringHash = delegate('getStringHash'), isFalseBoolean = delegate('isFalseBoolean'), isTrueBoolean = delegate('isTrueBoolean');
export const convertValueType = delegate('convertValueType'), timestampToMoment = delegate('timestampToMoment'), isDigitsOnly = delegate('isDigitsOnly'), escapeRegex = delegate('escapeRegex'), uuidv4 = delegate('uuidv4');
export const substituteParams = (...args: any[]) => hooks.script.substituteParams(...args);
export const getCharacterCardFieldsLazy = (...args: any[]) => hooks.script.getCharacterCardFieldsLazy(...args);
export const getInstructMacros = (...args: any[]) => hooks.instruct.getInstructMacros(...args);
export const getVariableMacros = (...args: any[]) => hooks.variables.getVariableMacros(...args);
export const formatInstructModeExamples = (...args: any[]) => hooks.instruct.formatInstructModeExamples(...args);
export const parseMesExamples = (...args: any[]) => hooks.script.parseMesExamples(...args);
export const getMaxContextTokens = (...args: any[]) => hooks.script.getMaxContextTokens(...args);
export const getMaxResponseTokens = (...args: any[]) => hooks.script.getMaxResponseTokens(...args);
export const getMaxPromptTokens = (...args: any[]) => hooks.script.getMaxPromptTokens(...args);
export const getCurrentLocale = () => frame?.locale ?? 'en';
export const getGeneratingModel = () => frame?.model ?? '';
export const getCurrentChatId = () => frame?.chatId ?? '';
export const getGroupNames = () => {
    const group = groups.find(item => item.id === selected_group);
    return group?.members?.map((member: any) => characters.find(character => character.avatar === member)?.name).filter(Boolean) ?? [];
};
export const isMobile = () => frame?.ui?.isMobile !== false;
export const collapseNewlines = (text: any) => text.replace(/\n{3,}/g, '\n\n');
export const getKayraMaxContextTokens = () => frame?.maxContext ?? max_context;
export const getGroupCharacterCardsLazy = (...args: any[]) => hooks.groupCards.getGroupCharacterCardsLazy(...args);
export function saveMetadataDebounced() { if (frame) frame.localDirty = true; }
export function saveSettingsDebounced() { if (frame) frame.globalDirty = true; }
export function validateVariableIndex(args: any) {
    if (args?.index === undefined) return;
    const index = Number(args.index);
    // Sparse arrays allocate during JSON serialization, before the final map
    // size guard can run. Reject that allocation at the upstream write seam.
    if (Number.isFinite(index) && index >= 0 && index > 10000) {
        if (frame) frame.limitExceeded = true;
        throw new Error('Macro variable index exceeds its allocation limit.');
    }
}
export function findExtension(name: any) {
    const normalize = (value: any) => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^(local|global)\//, 'third-party/');
    return frame?.extensions?.find((entry: any) => {
        const id = normalize(entry.id);
        return id === normalize(name) || id === normalize(`third-party/${name}`);
    }) ?? null;
}
export const document = {
    querySelector(selector: any) {
        if (selector === '#send_textarea') return { value: frame?.ui?.input ?? '' };
        if (selector === '#chat .mes') {
            const id = frame?.ui?.firstDisplayedMessageId;
            return id == null ? null : { getAttribute: (name: any) => name === 'mesid' ? String(id) : null };
        }
        throw new Error('The macro requested a browser-only DOM element.');
    },
};
export const $ = (selector: any) => ({ val: () => document.querySelector(selector)?.value ?? '' });
const listeners = new Map();
export const event_types = { GENERATION_STARTED: 'generation_started', CHAT_CHANGED: 'chat_changed' };
export const eventSource = {
    on(type: any, callback: any) { const list = listeners.get(type) ?? []; list.push(callback); listeners.set(type, list); },
    emit(type: any, ...args: any[]) { for (const callback of listeners.get(type) ?? []) callback(...args); },
};
function variables(global: any) {
    const call = (name: any, ...args: any[]) => {
        const prefix = global ? 'Global' : 'Local';
        return hooks.variables[`${name}${prefix}Variable`](...args);
    };
    return {
        get: (...args: any[]) => call('get', ...args), set: (...args: any[]) => call('set', ...args),
        add: (...args: any[]) => call('add', ...args), inc: (...args: any[]) => call('increment', ...args),
        dec: (...args: any[]) => call('decrement', ...args), has: (...args: any[]) => call('exists', ...args),
        del: (...args: any[]) => call('delete', ...args),
    };
}
const context = { variables: { local: variables(false), global: variables(true) } };
export const SillyTavern = { getContext: () => context };

/** All upstream evaluation is synchronous; frames cannot overlap an await. */
export function activate(next: any) {
    const previous = frame;
    frame = next;
    chat = next?.chat ?? [];
    chat_metadata = next?.metadata ?? {};
    power_user = next?.powerUser ?? { experimental_macro_engine: false, instruct: {}, context: {}, sysprompt: {} };
    main_api = next?.mainApi ?? 'openai';
    oai_settings = next?.oai ?? {};
    max_context = next?.maxContext ?? 4096;
    amount_gen = next?.maxResponse ?? 300;
    nai_settings = next?.novel ?? {};
    characters = next?.characters ?? [];
    this_chid = next?.characterIndex ?? 0;
    selected_group = next?.selectedGroup ?? null;
    groups = next?.groups ?? [];
    name1 = next?.userName ?? 'User'; name2 = next?.characterName ?? 'Character';
    extension_settings = next?.extensionSettings ?? { variables: { global: {} } };
    extension_prompts = next?.extensionPrompts ?? {};
    textgenerationwebui_banned_in_macros = next?.bannedWords ?? [];
    eventSource.emit(event_types.CHAT_CHANGED);
    const last = next?.lastGenerationType;
    if (last) eventSource.emit(event_types.GENERATION_STARTED, last, {}, false);
    return previous;
}
export const activeFrame = () => frame;
