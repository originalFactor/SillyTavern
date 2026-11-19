import { ApiError, getUserKey } from './contract.js';
import { complete, fail, recordPluginEvents, setFinalText, setUsage, stage, withChatLock } from './generation-store.js';
import { applyGlobalRegex, regex_placement } from './regex.js';
import { buildPrompt } from './prompt.js';
import {
    applyHeadlessHooks,
    applyHeadlessOutputHooks,
    emitHeadlessEvent,
    mergeEffects,
    persistPluginSettings,
} from './plugin-runtime.js';
import {
    createCharacterMessage,
    createUserMessage,
    readCharacter,
    readChat,
    resolveChatPath,
    writeChat,
} from './session.js';

/**
 * Runs a generation asynchronously and updates its event journal.
 *
 * The chat file is written ONCE, atomically, at successful completion. The
 * in-memory chat used for prompt assembly includes the new user message, but a
 * failure or cancellation must never leave an unanswered user row on disk.
 * Concurrent generations for the same chat are serialized with withChatLock.
 *
 * @param {import('express').Request} sourceRequest Authenticated source request
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {import('./generation-store.js').GenerationRecord} record Generation record
 * @param {object} input Generation input
 * @param {string} input.characterId Character identifier
 * @param {string} input.chatId Chat identifier
 * @param {string} input.type Generation type
 * @param {string} input.input User input or quiet prompt
 * @param {Record<string, any>} input.overrides Per-request provider overrides
 * @returns {Promise<void>} Generation promise
 */
export async function runGeneration(sourceRequest, session, record, input) {
    const startedAt = Date.now();
    const effects = { events: [], settingsPatch: {}, extensionPrompts: [], quietPrompts: [], warnings: [] };
    console.info('[api-v1] generation_started', JSON.stringify({
        requestId: record.requestId,
        userKey: getUserKey(session.handle),
        type: input.type,
    }));
    try {
        mergeEffects(effects, await emitHeadlessEvent(session, 'generation_started', { type: input.type, requestId: record.requestId }));
        stage(record, 'loading');
        const character = await readCharacter(session, input.characterId);
        const chatPath = resolveChatPath(session, input.characterId, input.chatId);

        const work = async () => {
            let chat = readChat(chatPath);
            if (chat.length === 0) {
                chat = [{ chat_metadata: {} }, createCharacterMessage(character.name, character.data.first_mes ?? '')];
            }

            // `regenerate` drops the trailing assistant reply and re-generates it.
            // `continue` keeps the transcript intact and appends to the last reply.
            if (input.type === 'regenerate') {
                while (chat.length > 1 && !chat[chat.length - 1].is_user) chat.pop();
            }
            if (input.type === 'normal' && typeof input.input === 'string' && input.input.length > 0) {
                chat.push(createUserMessage(session, input.input));
            }
            if (input.type === 'continue' && typeof input.input === 'string' && input.input.length > 0) {
                chat.push({ name: session.userName, is_user: true, is_system: true, mes: `[Continue] ${input.input}`, send_date: new Date().toISOString() });
            }

            stage(record, 'prompt');
            let built = buildPrompt(session, character.data, chat, { type: input.type, input: input.input, overrides: input.overrides ?? {} });
            const hooked = await applyHeadlessHooks(session, built, {
                characterId: input.characterId,
                chatId: input.chatId,
                characterName: character.name,
                chat,
                chatMetadata: chat[0]?.chat_metadata ?? {},
                generation: { requestId: record.requestId, type: input.type, phase: 'prompt' },
            });
            built = hooked.prompt;
            mergeEffects(effects, hooked.effects);
            recordPluginEvents(record, effects.events);

            stage(record, 'provider');
            const { runChatCompletion } = await import('./provider.js');
            const result = await runChatCompletion(sourceRequest, built.providerRequest, record);
            if (record.status === 'cancelled') return;

            let output = applyGlobalRegex(result.text, session.extensionSettings, regex_placement.AI_OUTPUT);
            const outputHooks = await applyHeadlessOutputHooks(session, output, {
                characterId: input.characterId,
                chatId: input.chatId,
                generation: { requestId: record.requestId, type: input.type, phase: 'afterGeneration' },
            });
            output = outputHooks.text;
            mergeEffects(effects, outputHooks.effects);
            setUsage(record, result.usage);
            setFinalText(record, output);
            mergeEffects(effects, await emitHeadlessEvent(session, 'generation_completed', { requestId: record.requestId, status: 'done' }));
            recordPluginEvents(record, effects.events);
            // Persist plugin settings BEFORE the terminal event so a client that
            // observes `done` can immediately read back the extension settings.
            persistPluginSettings(session, effects.settingsPatch);

            if (input.type === 'quiet') {
                complete(record, {
                    characterId: input.characterId,
                    chatId: input.chatId,
                    messageIndex: null,
                    text: output,
                    reasoning: result.reasoning,
                    warnings: built.warnings,
                    pluginEffects: summarizeEffects(effects),
                });
            } else {
                const messageIndex = commitMessages(chatPath, chat, character.name, output, result.reasoning, input.type);
                complete(record, {
                    characterId: input.characterId,
                    chatId: input.chatId,
                    messageIndex,
                    message: { name: character.name, is_user: false, mes: output, extra: result.reasoning ? { reasoning: result.reasoning } : {} },
                    warnings: built.warnings,
                    pluginEffects: summarizeEffects(effects),
                });
            }
            console.info('[api-v1] generation_finished', JSON.stringify({
                requestId: record.requestId,
                userKey: getUserKey(session.handle),
                status: record.status,
                durationMs: Date.now() - startedAt,
            }));
        };

        await withChatLock(chatPath, work);
    } catch (error) {
        if (record.status === 'cancelled') return;
        const apiError = error instanceof ApiError ? error : new ApiError(500, 'internal', 'Generation failed.');
        console.warn('[api-v1] generation_failed', JSON.stringify({
            requestId: record.requestId,
            userKey: getUserKey(session.handle),
            code: apiError.code,
            category: error instanceof ApiError ? 'expected' : 'unexpected',
            errorMessage: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
        }));
        fail(record, apiError.code, apiError.message, apiError.retryable);
    }
}

/**
 * Writes the user row and assistant row together, once, at successful completion.
 * @param {string} chatPath Chat file path
 * @param {Array<Record<string, any>>} chat In-memory chat including the new user row
 * @param {string} characterName Character name
 * @param {string} output Generated text
 * @param {string} reasoning Reasoning text
 * @param {string} type Generation type
 * @returns {number} Index of the assistant message
 */
function commitMessages(chatPath, chat, characterName, output, reasoning, type) {
    if (type === 'continue' && chat.length > 1 && !chat[chat.length - 1].is_user) {
        const last = chat[chat.length - 1];
        last.mes = `${String(last.mes ?? '')}${output}`;
        last.swipes = [last.mes];
    } else {
        chat.push(createCharacterMessage(characterName, output, reasoning));
    }
    writeChat(chatPath, chat);
    return chat.length - 1;
}

/**
 * Produces a bounded, non-sensitive summary of plugin effects for the snapshot.
 * @param {Record<string, any>} effects Effect accumulator
 * @returns {Record<string, any>} Summary
 */
function summarizeEffects(effects) {
    return {
        events: effects.events.length,
        extensionPrompts: effects.extensionPrompts.length,
        quietPrompts: effects.quietPrompts.length,
        settingsChanged: Object.keys(effects.settingsPatch).length,
        warnings: effects.warnings.slice(0, 16),
    };
}
