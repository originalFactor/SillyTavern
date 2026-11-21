/**
 * Headless compatibility shim for SillyTavern extensions.
 *
 * This module runs INSIDE the plugin worker (Node ESM), never in the browser and
 * never in the main server process. It recreates the small, safe subset of
 * `SillyTavern.getContext()` that extensions commonly use, so an extension
 * authored against the global `SillyTavern` API can be declared
 * `runtime: headless` and run without a browser tab.
 *
 * Anything that would require browser globals, provider credentials, arbitrary
 * network access or filesystem writes is either scoped, queued as an *effect*
 * for the host to service, or explicitly rejected. The worker receives only
 * structured-cloneable plain data and returns effects; it never receives the
 * Express request, session cookies, user directories or secret handles.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Event names mirroring `public/scripts/events.js`. Only the events that the
 * headless runtime can actually emit are exposed to plugins; the rest are
 * present as names so `eventSource.on(eventTypes.X, ...)` does not throw.
 */
export const HEADLESS_EVENT_TYPES = Object.freeze({
    APP_READY: 'app_ready',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_DELETED: 'message_deleted',
    CHAT_CHANGED: 'chat_id_changed',
    CHAT_CREATED: 'chat_created',
    CHAT_DELETED: 'chat_deleted',
    CHAT_RENAMED: 'chat_renamed',
    GENERATION_STARTED: 'generation_started',
    GENERATION_ENDED: 'generation_ended',
    GENERATION_STOPPED: 'generation_stopped',
    STREAM_TOKEN_RECEIVED: 'stream_token_received',
    WORLD_INFO_ACTIVATED: 'world_info_activated',
    SETTINGS_UPDATED: 'settings_updated',
    EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
    GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
    GENERATE_AFTER_DATA: 'generate_after_data',
});

/** Events the plugin is allowed to emit back into the generation event stream. */
const EMITTABLE_EVENTS = new Set([
    HEADLESS_EVENT_TYPES.MESSAGE_RECEIVED,
    HEADLESS_EVENT_TYPES.GENERATION_ENDED,
    HEADLESS_EVENT_TYPES.WORLD_INFO_ACTIVATED,
    HEADLESS_EVENT_TYPES.SETTINGS_UPDATED,
]);

const MAX_EVENTS = 64;
const MAX_PROMPTS = 16;
const MAX_QUIET_PROMPTS = 4;
const MAX_TEMPLATE_BYTES = 64 * 1024;
const MAX_TEMPLATE_KEYS = 64;
const MAX_TEXT_LENGTH = 64 * 1024;

/**
 * Removes anything that looks like a credential from a settings object before
 * it is handed to third-party plugin code.
 * @param {unknown} value Input value
 * @param {number} depth Recursion guard
 * @returns {unknown} Redacted value
 */
function redact(value, depth = 0) {
    if (depth > 8) return '[depth limit]';
    if (Array.isArray(value)) return value.slice(0, 256).map(item => redact(item, depth + 1));
    if (!value || typeof value !== 'object') return value;
    /** @type {Record<string, unknown>} */
    const output = {};
    for (const [key, item] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
        if (/key|token|secret|password|authorization|cookie|credential/i.test(key)) continue;
        output[key] = redact(item, depth + 1);
    }
    return output;
}

/**
 * Builds the compatibility context and its effect collector from plain data.
 * @param {Record<string, any>} data Structured-cloneable context data
 * @returns {{context: Record<string, any>, effects: HeadlessEffects}} Context and effects
 */
export function createPluginContext(data) {
    /** @typedef {{events: Array<{event: string, data: any}>, settingsPatch: Record<string, any>, extensionPrompts: Array<Record<string, any>>, quietPrompts: string[], warnings: string[]}} HeadlessEffects */
    /** @type {HeadlessEffects} */
    const effects = { events: [], settingsPatch: {}, extensionPrompts: [], quietPrompts: [], warnings: [] };
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const extensionSettings = data.extensionSettings && typeof data.extensionSettings === 'object' ? data.extensionSettings : {};
    const settings = redact(data.settings && typeof data.settings === 'object' ? data.settings : {}) ?? {};
    const eventTypes = { ...HEADLESS_EVENT_TYPES, ...(data.eventTypes ?? {}) };

    /** @type {Map<string, Array<(data: any) => void>>} */
    const listeners = new Map();
    const eventSource = {
        on(event, handler) {
            if (typeof handler !== 'function') return;
            const list = listeners.get(String(event)) ?? [];
            list.push(handler);
            listeners.set(String(event), list);
        },
        off(event, handler) {
            const list = listeners.get(String(event));
            if (list) listeners.set(String(event), list.filter(item => item !== handler));
        },
        once(event, handler) {
            const wrapped = (payload) => { eventSource.off(event, wrapped); handler(payload); };
            eventSource.on(event, wrapped);
        },
        async emit(event, payload = {}) {
            recordEvent(event, payload);
            for (const handler of listeners.get(String(event)) ?? []) {
                try { await handler(payload); } catch (error) { warn(`listener for ${event} failed: ${String(error)}`); }
            }
        },
        makeLast(...args) { warn(`eventSource.makeLast is not available headlessly (${args.length} args ignored)`); },
    };

    function recordEvent(event, payload) {
        if (!EMITTABLE_EVENTS.has(String(event))) return;
        if (effects.events.length >= MAX_EVENTS) { warn('plugin event limit reached'); return; }
        effects.events.push({ event: String(event), data: boundedJson(payload) });
    }

    function warn(message) {
        if (effects.warnings.length < MAX_EVENTS) effects.warnings.push(String(message).slice(0, 512));
    }

    function boundedJson(value) {
        try {
            const text = JSON.stringify(value ?? null) ?? 'null';
            return text.length > 4096 ? { truncated: true } : JSON.parse(text);
        } catch { return { unserializable: true }; }
    }

    const context = {
        // ---- identity / read-only state ----
        extensionId: data.extensionId,
        extensionName: data.extensionName,
        characterId: data.characterId ?? null,
        chatId: data.chatId ?? null,
        name1: data.name1 ?? '',
        name2: data.name2 ?? '',
        mainApi: data.mainApi ?? 'openai',
        maxContext: Number(data.maxContext ?? 16),
        chat: Array.isArray(data.chat) ? data.chat : [],
        chatMetadata: data.chatMetadata && typeof data.chatMetadata === 'object' ? data.chatMetadata : {},
        characters: Array.isArray(data.characters) ? data.characters : [],
        settings,
        extensionSettings,
        eventTypes,
        eventSource,
        generation: data.generation ?? {},

        // ---- mutable prompt ----
        messages,
        prompt: typeof data.prompt === 'string' ? data.prompt : null,
        setExtensionPrompt(key, value, position = 0, depth = 0, role = 0) {
            if (effects.extensionPrompts.length >= MAX_PROMPTS) { warn('extension prompt limit reached'); return; }
            effects.extensionPrompts.push({
                key: String(key).slice(0, 128),
                value: String(value ?? '').slice(0, MAX_TEXT_LENGTH),
                position: clampInt(position, 0, 7),
                depth: clampInt(depth, 0, 64),
                role: clampInt(role, 0, 2),
            });
        },

        // ---- settings persistence (host applies the delta) ----
        saveSettingsDebounced() { /* settings are tracked through writeExtensionField */ },
        saveSettings() { /* no-op: use writeExtensionField */ },
        writeExtensionField(name, field, value, bulk = false) {
            if (bulk && field && typeof field === 'object') {
                Object.assign(extensionSettings[name] ??= {}, field);
                effects.settingsPatch[name] ??= {};
                Object.assign(effects.settingsPatch[name], field);
                return;
            }
            (extensionSettings[name] ??= {})[String(field)] = value;
            (effects.settingsPatch[name] ??= {})[String(field)] = value;
        },
        writeExtensionFieldBulk(name, fields) {
            if (!fields || typeof fields !== 'object') return;
            Object.assign(extensionSettings[name] ??= {}, fields);
            effects.settingsPatch[name] ??= {};
            Object.assign(effects.settingsPatch[name], fields);
        },

        // ---- generation requests (queued; host services them, no network here) ----
        generateQuietPrompt(prompt) {
            if (effects.quietPrompts.length >= MAX_QUIET_PROMPTS) { warn('quiet prompt limit reached'); return Promise.resolve(''); }
            effects.quietPrompts.push(String(prompt ?? '').slice(0, MAX_TEXT_LENGTH));
            // The host may service this after the hook; plugins must not rely on the text.
            return Promise.resolve('');
        },
        generate() { return Promise.reject(new Error('SillyTavern.getContext().generate is not available in the headless runtime; use generateQuietPrompt.')); },
        sendStreamingRequest() { return Promise.reject(new Error('Streaming generation is not available inside a headless hook.')); },
        sendGenerationRequest() { return Promise.reject(new Error('Direct generation is not available inside a headless hook.')); },
        generateRaw() { return Promise.reject(new Error('Raw generation is not available inside a headless hook.')); },
        generateRawData() { return Promise.reject(new Error('Raw generation is not available inside a headless hook.')); },
        stopGeneration() { warn('stopGeneration is not available inside a headless hook'); },

        // ---- templates (bounded, local files only, no Handlebars) ----
        async renderExtensionTemplateAsync(_extensionName, template, templateData = {}, _sanitize = true, _localize = true) {
            try {
                const name = path.basename(String(template ?? ''));
                if (!name || !data.templateDir) return '';
                const filePath = path.resolve(String(data.templateDir), name);
                const root = path.resolve(String(data.templateDir));
                if (!filePath.startsWith(root + path.sep)) return '';
                const stat = fs.statSync(filePath);
                if (!stat.isFile() || stat.size > MAX_TEMPLATE_BYTES) return '';
                let html = fs.readFileSync(filePath, 'utf8');
                const entries = Object.entries(templateData && typeof templateData === 'object' ? templateData : {}).slice(0, MAX_TEMPLATE_KEYS);
                for (const [key, value] of entries) {
                    html = html.split(`{{${key}}}`).join(String(value ?? ''));
                }
                return html.slice(0, MAX_TEMPLATE_BYTES);
            } catch { return ''; }
        },
        renderExtensionTemplate() { warn('renderExtensionTemplate is deprecated; use renderExtensionTemplateAsync'); return ''; },

        // ---- macros ----
        substituteParams(text, variables = {}) {
            return String(text ?? '').replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, key) =>
                Object.hasOwn(variables, key) ? String(variables[key]) : match);
        },
        substituteParamsExtended(text) { return context.substituteParams(text, { char: context.name2, user: context.name1 }); },
        registerMacro() { warn('registerMacro is not supported in the headless runtime'); },
        unregisterMacro() { warn('unregisterMacro is not supported in the headless runtime'); },
        registerSlashCommand() { warn('slash commands are not supported in the headless runtime'); },
        registerFunctionTool() { warn('tool registration is not supported in the headless runtime'); },

        // ---- headers: deliberately credential-free ----
        getRequestHeaders() { return { 'Content-Type': 'application/json' }; },

        // ---- chat mutations: rejected rather than silently faked ----
        addOneMessage() { warn('chat mutation is not available inside a headless hook'); },
        deleteLastMessage() { warn('chat mutation is not available inside a headless hook'); },
        deleteMessage() { warn('chat mutation is not available inside a headless hook'); },
        sendSystemMessage() { warn('chat mutation is not available inside a headless hook'); },
        saveChat() { warn('chat writes are owned by the generation runtime'); },
        saveMetadata() { warn('metadata writes are owned by the generation runtime'); },
    };

    // Expose the ST global shape that many third-party extensions use.
    globalThis.SillyTavern = {
        getContext: () => context,
        getContextAsync: async () => context,
    };

    return { context, effects };
}

/**
 * Clamps an integer into a range.
 * @param {unknown} value Input
 * @param {number} min Minimum
 * @param {number} max Maximum
 * @returns {number} Clamped value
 */
function clampInt(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, Math.trunc(number)));
}
