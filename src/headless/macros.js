import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from './contract.js';
import { createChat, readChat, readSettings, resolveChatPath, writeChat, writeSettings } from './session.js';
import { assertChatIdle } from './generation-store.js';
import { parseExampleIntoIndividual } from './macro-runtime/generated/instruct.js';
import { evaluateNativeMacros, inMacroFrame, upstreamMacroScript } from './macro-runtime/index.js';

const clone = value => JSON.parse(JSON.stringify(value ?? {}));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function variableMap(value, frame) {
    if (value == null) value = {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'validation', 'Macro variables must be a JSON object.');
    const target = Object.assign(Object.create(null), clone(value));
    const sizeOf = (key, entry) => Buffer.byteLength(String(key)) + Buffer.byteLength(JSON.stringify(entry) ?? '');
    const sizes = new Map(Object.entries(target).map(([key, entry]) => [key, sizeOf(key, entry)]));
    let bytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
    if (bytes > 8_388_608) throw new ApiError(422, 'validation', 'Macro variable state exceeds its size limit.');
    return new Proxy(target, {
        set(object, key, entry) {
            const size = sizeOf(key, entry);
            if (bytes - (sizes.get(key) ?? 0) + size > 8_388_608) { frame.limitExceeded = true; throw new Error('Macro variable state exceeded its size limit.'); }
            bytes += size - (sizes.get(key) ?? 0); sizes.set(key, size);
            Object.defineProperty(object, key, { value: entry, writable: true, configurable: true, enumerable: true });
            return true;
        },
        deleteProperty(object, key) { bytes -= sizes.get(key) ?? 0; sizes.delete(key); return Reflect.deleteProperty(object, key); },
    });
}

/** One isolated evaluation frame shared by all parts of a single prompt. */
export function createMacroContext(session, character, chat, { type = 'normal', input = '', overrides = {}, characterId = '', chatId = '', nativeContext = {}, macroChat = null, preview = false, extensions = [] } = {}) {
    const settings = session.settings;
    const power = settings.power_user ?? {};
    const metadata = clone(chat[0]?.chat_metadata);
    const live = session.directories?.root && fs.existsSync(path.join(session.directories.root, 'settings.json')) ? readSettings(session.directories) : settings;
    const originalGlobals = clone(live.extension_settings?.variables?.global);
    const userName = String(session.userName || 'User');
    const characterName = String(character.name || 'Character');
    const frame = {
        operations: 0, generatedCharacters: 0, warnings: [], limitExceeded: false,
        localDirty: false, globalDirty: false,
        userName, characterName, mainApi: String(settings.main_api ?? 'openai'),
        chatId, characterId, chat: (macroChat ?? chat).filter(message => typeof message?.mes === 'string').map(clone),
        metadata, extensions, extensionPrompts: clone(nativeContext.extensionPrompts),
        extensionSettings: { variables: { global: {} } }, bannedWords: [],
        locale: nativeContext.locale ?? 'en', timeZone: nativeContext.timeZone,
        ui: { input: nativeContext.input ?? input, firstDisplayedMessageId: nativeContext.firstDisplayedMessageId, isMobile: nativeContext.isMobile ?? true },
        now: nativeContext.now,
        lastGenerationType: preview ? nativeContext.lastGenerationType ?? '' : type,
        maxContext: Number(settings.oai_settings?.openai_max_context ?? settings.max_context ?? 4096),
        maxResponse: Number(overrides.maxTokens ?? settings.oai_settings?.openai_max_tokens ?? settings.amount_gen ?? 300),
        model: String(overrides.model ?? (settings.oai_settings?.chat_completion_source === 'custom' ? settings.oai_settings?.custom_model : settings.oai_settings?.openai_model) ?? ''),
        oai: { openai_max_context: Number(settings.oai_settings?.openai_max_context ?? 4096), openai_max_tokens: Number(overrides.maxTokens ?? settings.oai_settings?.openai_max_tokens ?? settings.amount_gen ?? 300) },
        powerUser: {
            ...clone(power), experimental_macro_engine: power.experimental_macro_engine !== false,
            prefer_character_prompt: power.prefer_character_prompt !== false, prefer_character_jailbreak: power.prefer_character_jailbreak !== false,
            instruct: { enabled: false, ...clone(power.instruct) }, context: clone(power.context), sysprompt: { enabled: true, ...clone(power.sysprompt) },
        },
        exampleParser: parseExampleIntoIndividual,
        characters: [{ ...clone(character), name: characterName, avatar: characterId ? `${characterId}.png` : '', data: clone(character) }],
    };
    frame.metadata.variables = variableMap(metadata.variables, frame);
    frame.extensionSettings.variables.global = variableMap(originalGlobals, frame);
    return {
        frame,
        expand: (text, options = {}) => evaluateNativeMacros(frame, String(text ?? ''), options),
        fields: () => inMacroFrame(frame, () => upstreamMacroScript.getCharacterCardFields()),
        examples: text => inMacroFrame(frame, () => upstreamMacroScript.parseMesExamples(text, false)),
        run: callback => inMacroFrame(frame, callback),
        effects: () => ({
            localDirty: frame.localDirty, globalDirty: frame.globalDirty,
            metadata: clone(frame.metadata), globals: clone(frame.extensionSettings.variables.global),
            originalGlobalDigest: digest(originalGlobals),
        }),
    };
}

/** Preview is dry-run; actual generations publish macro effects before dispatch. */
export function persistMacroEffects(session, chatPath, chat, effects) {
    if (!effects) return;
    if (effects.globalDirty) {
        const latest = readSettings(session.directories);
        const current = latest.extension_settings?.variables?.global ?? {};
        if (digest(current) !== effects.originalGlobalDigest) throw new ApiError(409, 'conflict', 'Global macro variables changed during prompt preparation. Inspect state before another attempt.');
        latest.extension_settings ??= {};
        latest.extension_settings.variables = { ...(latest.extension_settings.variables ?? {}), global: effects.globals };
        writeSettings(session.directories, latest);
    }
    if (effects.localDirty) {
        const saved = readChat(chatPath);
        if (saved.length === 0) throw new ApiError(409, 'conflict', 'Macro metadata needs an existing chat.');
        saved[0].chat_metadata = { ...(saved[0].chat_metadata ?? {}), ...effects.metadata };
        writeChat(chatPath, saved);
    }
    chat[0] ??= { chat_metadata: {} };
    chat[0].chat_metadata = { ...(chat[0].chat_metadata ?? {}), ...effects.metadata };
}

/** Expand once after checking identity; commit the greeting and local state together. */
export async function createMacroChat(session, character, characterId, chatId, firstMessage, nativeContext = {}, extensions = []) {
    const chatPath = resolveChatPath(session, characterId, chatId);
    if (fs.existsSync(chatPath)) throw new ApiError(409, 'conflict', 'Chat already exists.');
    const chat = [{ chat_metadata: {} }];
    const { runNativeText } = await import('./prompt.js');
    const result = await runNativeText(session, character, chat, { mode: 'greeting', text: firstMessage, type: '', characterId, chatId, nativeContext, extensions });
    // Evaluation yields. Recheck identity and admission before publishing any
    // computed effects; competing creators must not overwrite the winner.
    assertChatIdle(session.handle, characterId, chatId, session.directories);
    if (fs.existsSync(chatPath)) throw new ApiError(409, 'conflict', 'Chat already exists.');
    const effects = result.macroEffects;
    // As with generation preparation, global macro effects precede transcript
    // publication and are not rolled back by a later filesystem failure.
    try {
        persistMacroEffects(session, null, chat, { ...effects, localDirty: false });
        const created = createChat(session, characterId, chatId, result.text, character.name, { metadata: effects.metadata, macroWarnings: result.warnings.macroWarnings, regexWarnings: result.warnings.regexWarnings });
        return { ...created, warnings: { ...result.warnings, macroStateChanges: { local: effects.localDirty, global: effects.globalDirty } } };
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, 'unknown', 'Chat creation could not be confirmed after macro preparation. Global variable changes may already be saved. Inspect the chat and variables before creating again.');
    }
}
