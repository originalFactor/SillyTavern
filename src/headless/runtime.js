import { ApiError, getUserKey } from './contract.js';
import { complete, fail, recordPluginEvents, beginGeneration, endGeneration, shouldStopGeneration, setFinalText, setUsage, stage, withChatLock } from './generation-store.js';
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
    if (!beginGeneration(record)) return;
    const startedAt = Date.now();
    const effects = { events: [], settingsPatch: {}, extensionPrompts: [], quietPrompts: [], warnings: [] };
    console.info('[api-v1] generation_started', JSON.stringify({
        requestId: record.requestId,
        userKey: getUserKey(session.handle),
        type: input.type,
    }));
    try {
        mergeEffects(effects, await emitHeadlessEvent(session, 'generation_started', { type: input.type, requestId: record.requestId }));
        if (shouldStopGeneration(record)) return;
        stage(record, 'loading');
        const character = await readCharacter(session, input.characterId);
        if (shouldStopGeneration(record)) return;
        const chatPath = resolveChatPath(session, input.characterId, input.chatId);

        const work = async () => {
            if (shouldStopGeneration(record)) return;
            let chat = readChat(chatPath);
            if (chat.length === 0) {
                chat = [{ chat_metadata: {} }, createCharacterMessage(character.name, character.data.first_mes ?? '')];
            }

            // Preserve the selected reply until successful atomic commit, then
            // append the regenerated alternative to its swipe history.
            // `continue` keeps the transcript intact and appends to the last reply.
            let previousReply = null;
            if (['regenerate', 'continue'].includes(input.type)) {
                const last = chat.at(-1);
                if (chat.length <= 1 || last.is_user || typeof last.mes !== 'string') {
                    throw new ApiError(409, 'conflict', 'The last message must be an assistant reply.');
                }
                if (input.type === 'regenerate') previousReply = chat.pop();
            }
            if (input.type === 'normal' && typeof input.input === 'string' && input.input.length > 0) {
                chat.push(createUserMessage(session, input.input));
            }

            stage(record, 'prompt');
            let built = buildPrompt(session, character.data, chat, { type: input.type, input: input.input, overrides: input.overrides ?? {} });
            if (input.type === 'continue' && input.input) {
                // Continuation instructions affect the request only, never the
                // stored transcript or which assistant message receives text.
                built.messages.push({ role: 'system', content: String(input.input) });
            }
            const hooked = await applyHeadlessHooks(session, built, {
                characterId: input.characterId,
                chatId: input.chatId,
                characterName: character.name,
                chat,
                chatMetadata: chat[0]?.chat_metadata ?? {},
                generation: { requestId: record.requestId, type: input.type, phase: 'prompt' },
            });
            if (shouldStopGeneration(record)) return;
            built = hooked.prompt;
            mergeEffects(effects, hooked.effects);
            recordPluginEvents(record, effects.events);

            stage(record, 'provider');
            const { runSessionChatCompletion } = await import('./provider.js');
            const result = await runSessionChatCompletion(sourceRequest, built.providerRequest, record, session);
            if (shouldStopGeneration(record)) return;

            let output = applyGlobalRegex(result.text, session.extensionSettings, regex_placement.AI_OUTPUT);
            const outputHooks = await applyHeadlessOutputHooks(session, output, {
                characterId: input.characterId,
                chatId: input.chatId,
                generation: { requestId: record.requestId, type: input.type, phase: 'afterGeneration' },
            });
            if (shouldStopGeneration(record)) return;
            output = outputHooks.text;
            mergeEffects(effects, outputHooks.effects);
            setUsage(record, result.usage);
            setFinalText(record, output);
            mergeEffects(effects, await emitHeadlessEvent(session, 'generation_completed', { requestId: record.requestId, status: 'done' }));
            if (shouldStopGeneration(record)) return;
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
                }, { committed: false });
            } else {
                const messageIndex = commitMessages(chatPath, chat, character.name, output, result.reasoning, input.type, previousReply);
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
        if (shouldStopGeneration(record)) return;
        const apiError = error instanceof ApiError ? error
            : new ApiError(500, record.providerDispatched ? 'unknown' : 'internal', record.providerDispatched ? 'Local processing failed after provider dispatch. The request may have been billed; inspect the chat before sending again.' : 'Generation failed.');
        console.warn('[api-v1] generation_failed', JSON.stringify({
            requestId: record.requestId,
            userKey: getUserKey(session.handle),
            code: apiError.code,
            category: error instanceof ApiError ? 'expected' : 'unexpected',
            errorMessage: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
        }));
        fail(record, apiError.code === 'storage' && record.providerDispatched ? 'unknown' : apiError.code, apiError.message, apiError.retryable);
    } finally { endGeneration(record); }
}

/**
 * Writes the user row and assistant row together, once, at successful completion.
 * @param {string} chatPath Chat file path
 * @param {Array<Record<string, any>>} chat In-memory chat including the new user row
 * @param {string} characterName Character name
 * @param {string} output Generated text
 * @param {string} reasoning Reasoning text
 * @param {string} type Generation type
 * @param {Record<string, any>|null} previousReply Previous reply for regeneration
 * @returns {number} Index of the assistant message
 */
function commitMessages(chatPath, chat, characterName, output, reasoning, type, previousReply = null) {
    if (type === 'continue' && chat.length > 1 && !chat[chat.length - 1].is_user) {
        const last = chat[chat.length - 1];
        last.swipes = Array.isArray(last.swipes) && last.swipes.length ? [...last.swipes] : [String(last.mes ?? '')];
        last.swipe_info = Array.isArray(last.swipe_info) ? [...last.swipe_info] : [];
        last.mes = `${String(last.mes ?? '')}${output}`;
        const selected = Number.isInteger(last.swipe_id) && last.swipe_id >= 0 && last.swipe_id < last.swipes.length ? last.swipe_id : 0;
        last.swipes[selected] = last.mes;
        last.swipe_id = selected;
        last.extra = { ...last.extra, reasoning: `${String(last.extra?.reasoning ?? '')}${reasoning}` };
        last.swipe_info[selected] = { ...last.swipe_info[selected], extra: { ...last.extra } };
    } else if (type === 'regenerate' && previousReply) {
        const swipes = Array.isArray(previousReply.swipes) && previousReply.swipes.length
            ? [...previousReply.swipes] : [String(previousReply.mes)];
        const selected = Number.isInteger(previousReply.swipe_id) && previousReply.swipe_id >= 0 && previousReply.swipe_id < swipes.length
            ? previousReply.swipe_id : 0;
        swipes[selected] = String(previousReply.mes);
        const swipeInfo = Array.from({ length: swipes.length }, (_, i) => previousReply.swipe_info?.[i] ?? { extra: {} });
        swipeInfo[selected] = { ...swipeInfo[selected], extra: { ...previousReply.extra } };
        swipes.push(output);
        const extra = { ...previousReply.extra, reasoning: reasoning || '' };
        swipeInfo.push({ extra });
        chat.push({ ...previousReply, mes: output, swipes, swipe_info: swipeInfo, swipe_id: swipes.length - 1, extra });
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
