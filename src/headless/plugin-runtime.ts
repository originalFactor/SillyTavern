import path from 'node:path';
import url from 'node:url';
import { Worker } from 'node:worker_threads';

import { getConfigValue, isPathUnderParent } from '../util.js';
import { listExtensions } from './prompt.js';
import { serverDirectory } from '../server-directory.js';
import { HEADLESS_EVENT_TYPES } from './plugin-context.js';
import { readSettings, writeSettings } from './session.js';
import { ApiError } from './contract.js';

const DEFAULT_HOOK_TIMEOUT_MS = 5000;
const MAX_HOOK_TEXT = 64 * 1024;
const MAX_PLUGIN_EVENTS = 64;

/** Hook names, in lifecycle order. Only declared hooks are invoked. */
export const HEADLESS_HOOKS = Object.freeze({
    BEFORE_PROMPT: 'beforePrompt',
    AFTER_PROMPT: 'afterPrompt',
    GENERATION_EVENT: 'onGenerationEvent',
    AFTER_GENERATION: 'afterGeneration',
});

export interface HeadlessEffects {
    events: Array<{ event: string; data: any }>;
    settingsPatch: Record<string, any>;
    extensionPrompts: Array<Record<string, any>>;
    quietPrompts: string[];
    warnings: string[];
}

/**
 * Creates an empty effect accumulator.
 * @returns {HeadlessEffects} Empty effects
 */
export function emptyEffects(): HeadlessEffects {
    return { events: [], settingsPatch: {}, extensionPrompts: [], quietPrompts: [], warnings: [] };
}

/**
 * Checks whether trusted headless plugin hooks are enabled.
 * Driven only by explicit config/env so the path is testable.
 * @returns {boolean} Whether headless plugins are enabled
 */
function areHeadlessPluginsEnabled() {
    const env = process.env.SILLYTAVERN_API_V1_HEADLESSPLUGINS;
    if (env === 'true') return true;
    if (env === 'false') return false;
    return !!getConfigValue('api.v1.headlessPlugins', false, 'boolean');
}

/**
 * Checks whether trusted headless plugin hooks are enabled.
 * @returns {boolean} Whether headless plugins are enabled
 */
export function areHeadlessPluginHooksEnabled() {
    return areHeadlessPluginsEnabled();
}

/**
 * Gets the configured per-hook timeout.
 * @returns {number} Timeout in milliseconds
 */
function hookTimeoutMs() {
    const raw = process.env.SILLYTAVERN_API_V1_HEADLESSPLUGIN_TIMEOUT_MS
        ?? getConfigValue('api.v1.headlessPluginTimeoutMs', DEFAULT_HOOK_TIMEOUT_MS, 'number');
    const configured = Number(raw);
    return Number.isFinite(configured) && configured > 0 ? Math.min(60_000, configured) : DEFAULT_HOOK_TIMEOUT_MS;
}

/**
 * Selects enabled headless extensions that declare a given hook. An empty
 * `hooks` list means the extension may implement any hook (the worker simply
 * finds no exported handler when it does not).
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {string} hook Hook name
 * @returns {Array<Record<string, any>>} Matching extensions
 */
function eligibleExtensions(session: import('./session.js').HeadlessSession, hook: string) {
    if (!areHeadlessPluginsEnabled()) return [];
    return listExtensions(session).filter(extension =>
        extension.runtime === 'headless'
        && extension.enabled
        && extension.entry
        && (!extension.hooks?.length || extension.hooks.includes(hook)));
}

/**
 * Resolves a trusted headless extension entry under the known extension roots.
 * Uses the *session's* user directory for local extensions so multi-user
 * installs resolve correctly.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {Record<string, any>} extension Extension metadata
 * @returns {string|null} Entry path or null
 */
function resolveExtensionEntry(session: import('./session.js').HeadlessSession, extension: Record<string, any>) {
    const roots: Record<string, any> = {
        system: path.join(serverDirectory, 'compat-source/upstream', 'scripts', 'extensions'),
        local: session.directories.extensions,
        global: path.join(serverDirectory, 'compat-source/upstream', 'scripts', 'extensions', 'third-party'),
    };
    const [type, ...nameParts] = String(extension.id).split('/');
    const root = roots[type];
    if (!root) return null;
    const name = nameParts.length > 0 ? nameParts.join('/') : String(extension.id);
    const entryPath = path.resolve(root, name, String(extension.entry));
    if (!isPathUnderParent(root, entryPath) || !/\.(mjs|js)$/.test(entryPath)) return null;
    return entryPath;
}

/**
 * Builds the bounded, credential-free data snapshot handed to the worker.
 * Secrets are redacted before third-party plugin code can see them.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {import('./prompt.js').BuiltPrompt} prompt Built prompt
 * @param {Record<string, any>} extra Extra generation context
 * @returns {Record<string, any>} Plain data
 */
function buildHookData(session: import('./session.js').HeadlessSession, prompt: import('./prompt.js').BuiltPrompt, extra: Record<string, any> = {}) {
    return {
        extensionId: extra.extensionId,
        extensionName: extra.extensionName,
        messages: prompt?.messages ?? [],
        prompt: typeof prompt?.prompt === 'string' ? prompt.prompt : null,
        settings: session.settings,
        extensionSettings: session.extensionSettings ?? {},
        chat: Array.isArray(extra.chat) ? extra.chat.slice(-64) : [],
        chatMetadata: extra.chatMetadata ?? {},
        characters: Array.isArray(extra.characters) ? extra.characters : [],
        characterId: extra.characterId ?? null,
        chatId: extra.chatId ?? null,
        name1: session.userName,
        name2: extra.characterName ?? '',
        mainApi: String(session.settings.main_api ?? 'openai'),
        maxContext: Number(session.settings.max_context ?? 16),
        eventTypes: HEADLESS_EVENT_TYPES,
        generation: extra.generation ?? {},
        templateDir: extra.templateDir ?? null,
    };
}

/**
 * Executes one headless hook in a worker with a hard timeout and returns its
 * result. Never throws for plugin failures; returns `{ok:false}` instead.
 * @param {Record<string, any>} extension Extension metadata
 * @param {string} entryPath Absolute plugin entry path
 * @param {string} hook Hook name
 * @param {Record<string, any>} data Structured-cloneable hook data
 * @returns {Promise<Record<string, any>>} Hook result
 */
async function runHook(extension: Record<string, any>, entryPath: string, hook: string, data: Record<string, any>) {
    const worker = new Worker(new URL('./plugin-worker.js', import.meta.url), {
        workerData: { entry: url.pathToFileURL(entryPath).href, hook, context: data },
    });
    try {
        return await Promise.race([
            new Promise<Record<string, any>>(resolve => worker.once('message', resolve)),
            new Promise<Record<string, any>>(resolve => worker.once('error', (error: Error) => {
                console.warn('[api-v1] Headless extension hook failed:', extension.id, error.message);
                resolve({ ok: false, error: error.message });
            })),
            new Promise<Record<string, any>>(resolve => worker.once('exit', (code: number) => resolve({ ok: false, error: `Worker exited with ${code}.` }))),
            new Promise<Record<string, any>>(resolve => {
                const timer = setTimeout(() => resolve({ ok: false, error: 'Hook timed out.' }), hookTimeoutMs());
                timer.unref?.();
            }),
        ]);
    } finally {
        await worker.terminate();
    }
}

/**
 * Applies `beforePrompt` and `afterPrompt` hooks to a built prompt. The
 * worker's returned `messages` are applied — this is the step that makes the
 * hooks effective; discarding them would silently drop every plugin mutation.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {import('./prompt.js').BuiltPrompt} prompt Built prompt
 * @param {Record<string, any>} [extra] Extra generation context
 * @returns {Promise<{prompt: import('./prompt.js').BuiltPrompt, effects: HeadlessEffects}>} Hooked prompt and effects
 */
export async function applyHeadlessHooks(session: import('./session.js').HeadlessSession, prompt: import('./prompt.js').BuiltPrompt, extra: Record<string, any> = {}) {
    const effects = emptyEffects();
    if (!areHeadlessPluginsEnabled()) return { prompt, effects };
    for (const hook of [HEADLESS_HOOKS.BEFORE_PROMPT, HEADLESS_HOOKS.AFTER_PROMPT]) {
        for (const extension of eligibleExtensions(session, hook)) {
            const result = await invoke(session, extension, hook, prompt, extra, effects);
            if (typeof prompt.prompt === 'string') {
                if (result.ok && Array.isArray(result.messages) && result.messages.length) throw new ApiError(422, 'unsupported', 'This hook returned chat messages for a string prompt. Use context.prompt for text completions.');
                if (result.ok && typeof result.prompt === 'string') {
                    if (!result.prompt.length || result.prompt.length > 8_388_608) throw new ApiError(422, 'validation', 'Hook string prompt exceeds its nonempty size bound.');
                    prompt.prompt = result.prompt;
                }
            } else if (result.ok && Array.isArray(result.messages)) prompt.messages = result.messages;
        }
    }
    if (typeof prompt.prompt === 'string') {
        if (effects.extensionPrompts.length) throw new ApiError(422, 'unsupported', 'Browser-style extension prompt placement needs the native string injection lifecycle.');
        if (prompt.providerRequest) prompt.providerRequest.prompt = prompt.prompt;
        return { prompt, effects };
    }
    applyExtensionPrompts(prompt, effects.extensionPrompts);
    // buildProviderRequest captured a reference to the original messages array.
    // Hooks may replace `prompt.messages`, so re-point the provider request at the
    // final array; otherwise plugin prompt edits never reach the model.
    if (prompt.providerRequest) prompt.providerRequest.messages = prompt.messages;
    return { prompt, effects };
}

/**
 * Applies ST-style extension prompts collected from plugin hooks.
 * @param {import('./prompt.js').BuiltPrompt} prompt Built prompt
 * @param {Array<Record<string, any>>} prompts Extension prompts
 * @returns {void}
 */
function applyExtensionPrompts(prompt: import('./prompt.js').BuiltPrompt, prompts: Array<Record<string, any>>) {
    for (const item of prompts.slice(0, 16)) {
        const text = String(item.value ?? '').slice(0, MAX_HOOK_TEXT);
        if (!text) continue;
        const role = item.role === 1 ? 'user' : item.role === 2 ? 'assistant' : 'system';
        const message = { role, content: text };
        if (item.position === 1) {
            prompt.messages.push(message);
        } else if (item.position === 4) {
            const index = Math.max(0, prompt.messages.length - Number(item.depth ?? 0));
            prompt.messages.splice(index, 0, message);
        } else {
            const firstNonSystem = prompt.messages.findIndex(entry => entry.role !== 'system');
            prompt.messages.splice(firstNonSystem === -1 ? prompt.messages.length : firstNonSystem, 0, message);
        }
    }
}

/**
 * Runs post-generation output hooks. A hook may replace the output by writing
 * `context.generation.text` or by returning a string.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {string} text Generated text
 * @param {Record<string, any>} [extra] Extra generation context
 * @returns {Promise<{text: string, effects: HeadlessEffects}>} Transformed text and effects
 */
export async function applyHeadlessOutputHooks(session: import('./session.js').HeadlessSession, text: string, extra: Record<string, any> = {}) {
    const effects = emptyEffects();
    if (!areHeadlessPluginsEnabled()) return { text, effects };
    let output = text;
    for (const extension of eligibleExtensions(session, HEADLESS_HOOKS.AFTER_GENERATION)) {
        const generation = { ...(extra.generation ?? {}), text: output };
        const result = await invoke(session, extension, HEADLESS_HOOKS.AFTER_GENERATION,
            { messages: [], providerRequest: {} }, { ...extra, generation }, effects);
        if (!result.ok) continue;
        const candidate = result.returnedText ?? result.generationText;
        if (typeof candidate === 'string' && candidate.length <= MAX_HOOK_TEXT) output = candidate;
    }
    return { text: output, effects };
}

/**
 * Emits a lifecycle event to trusted headless extensions and collects effects.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {string} event Event name
 * @param {Record<string, any>} data Event data
 * @returns {Promise<HeadlessEffects>} Collected effects
 */
export async function emitHeadlessEvent(session: import('./session.js').HeadlessSession, event: string, data: Record<string, any> = {}) {
    const effects = emptyEffects();
    if (!areHeadlessPluginsEnabled()) return effects;
    for (const extension of eligibleExtensions(session, HEADLESS_HOOKS.GENERATION_EVENT)) {
        await invoke(session, extension, HEADLESS_HOOKS.GENERATION_EVENT, { messages: [], providerRequest: {} },
            { generation: { event, ...data }, event }, effects);
    }
    return effects;
}

/**
 * Invokes a single hook and folds its effects into the accumulator.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {Record<string, any>} extension Extension metadata
 * @param {string} hook Hook name
 * @param {import('./prompt.js').BuiltPrompt} prompt Prompt
 * @param {Record<string, any>} extra Extra context
 * @param {HeadlessEffects} effects Effect accumulator
 * @returns {Promise<{ok: boolean, messages?: any[], generationText?: string|null, returnedText?: string|null}>} Result
 */
async function invoke(session: import('./session.js').HeadlessSession, extension: Record<string, any>, hook: string, prompt: import('./prompt.js').BuiltPrompt, extra: Record<string, any>, effects: any) {
    const entryPath = resolveExtensionEntry(session, extension);
    if (!entryPath) return { ok: false };
    const data = buildHookData(session, prompt, {
        ...extra,
        extensionId: extension.id,
        extensionName: extension.displayName,
        templateDir: path.dirname(entryPath),
    });
    const result = await runHook(extension, entryPath, hook, data);
    if (!result?.ok) {
        if (result?.error) effects.warnings.push(`${extension.id}:${hook}: ${result.error}`);
        return { ok: false };
    }
    if (Array.isArray(result.effects?.events)) {
        for (const item of result.effects.events.slice(0, MAX_PLUGIN_EVENTS)) {
            effects.events.push({ ...item, extensionId: extension.id });
        }
    }
    if (Array.isArray(result.effects?.extensionPrompts)) effects.extensionPrompts.push(...result.effects.extensionPrompts);
    if (Array.isArray(result.effects?.quietPrompts)) effects.quietPrompts.push(...result.effects.quietPrompts);
    if (Array.isArray(result.effects?.warnings)) effects.warnings.push(...result.effects.warnings.slice(0, MAX_PLUGIN_EVENTS));
    if (result.effects?.settingsPatch && typeof result.effects.settingsPatch === 'object') {
        for (const [name, fields] of Object.entries(result.effects.settingsPatch)) {
            if (!fields || typeof fields !== 'object') continue;
            (effects.settingsPatch[name] ??= {});
            Object.assign(effects.settingsPatch[name], fields);
        }
    }
    return {
        ok: true,
        messages: result.messages,
        prompt: result.prompt,
        generationText: result.generationText ?? null,
        returnedText: result.returnedText ?? null,
    };
}

/**
 * Persists a plugin settings delta back to user settings.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {Record<string, any>} patch Settings delta
 * @returns {void}
 */
export function persistPluginSettings(session: import('./session.js').HeadlessSession, patch: Record<string, any>) {
    if (!patch || Object.keys(patch).length === 0) return;
    const settings = readSettings(session.directories);
    settings.extension_settings ??= {};
    for (const [name, fields] of Object.entries(patch)) {
        settings.extension_settings[name] = { ...(settings.extension_settings[name] ?? {}), ...fields };
    }
    writeSettings(session.directories, settings);
}

/**
 * Merges one effect accumulator into another.
 * @param {HeadlessEffects} target Target accumulator
 * @param {HeadlessEffects} source Source accumulator
 * @returns {void}
 */
export function mergeEffects(target: any, source: any) {
    if (!source) return;
    target.events.push(...source.events);
    target.extensionPrompts.push(...source.extensionPrompts);
    target.quietPrompts.push(...source.quietPrompts);
    target.warnings.push(...source.warnings);
    for (const [name, fields] of Object.entries(source.settingsPatch ?? {})) {
        (target.settingsPatch[name] ??= {});
        Object.assign(target.settingsPatch[name], fields);
    }
}
