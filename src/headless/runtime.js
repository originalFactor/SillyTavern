import { ApiError, getUserKey } from './contract.js';
import { complete, fail, recordPluginEvents, beginGeneration, endGeneration, shouldStopGeneration, setFinalText, setFinalReasoning, setUsage, stage, withChatLock } from './generation-store.js';
import { buildPrompt, runNativeText, auditPrompt } from './prompt.js';
import { persistMacroEffects } from './macros.js';
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
            const macroChat = previousReply ? [...chat, { ...previousReply, swipe_id: previousReply.swipes?.length ?? 1 }] : chat;
            let built = await buildPrompt(session, character.data, chat, {
                type: input.type, input: input.input, overrides: input.overrides ?? {},
                characterId: input.characterId, chatId: input.chatId, nativeContext: input.nativeContext,
                macroChat,
                stageUserInput: input.type === 'normal' && Boolean(input.input),
            });
            if (shouldStopGeneration(record)) return;
            if (built.stagedUserMessage !== undefined) {
                chat.at(-1).mes = built.stagedUserMessage;
                chat.at(-1).swipes = [built.stagedUserMessage];
            }
            // Upstream variable macros run during preparation. Publish their
            // metadata effects before the first awaited hook/provider dispatch,
            // preserving the saved transcript until successful completion.
            persistMacroEffects(session, chatPath, chat, built.macroEffects);
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

            stage(record, 'budget');
            built.warnings.tokenBudget = await auditPrompt(session, built.providerRequest);
            if (shouldStopGeneration(record)) return;
            stage(record, 'provider');
            const { runSessionCompletion } = await import('./provider.js');
            const result = await runSessionCompletion(sourceRequest, built.providerRequest, record, session);
            if (shouldStopGeneration(record)) return;
            if (result.tokenBudget) built.warnings.tokenBudget = result.tokenBudget;
            setUsage(record, result.usage);

            let formatted;
            try {
                formatted = await runNativeText(session, character.data, chat, { mode: 'output', text: result.text, reasoning: result.reasoning, type: input.type, characterId: input.characterId, chatId: input.chatId, nativeContext: input.nativeContext });
            } catch {
                throw new ApiError(500, 'unknown', 'The provider completed but local regex formatting failed. The request may have been billed; inspect the retained raw generation before sending again.');
            }
            if (shouldStopGeneration(record)) return;
            let output = formatted.text;
            const reasoning = formatted.reasoning;
            built.warnings.regexWarnings = [...(built.warnings.regexWarnings ?? []), ...formatted.warnings.regexWarnings];
            built.warnings.macroWarnings = [...(built.warnings.macroWarnings ?? []), ...formatted.warnings.macroWarnings];
            const outputHooks = await applyHeadlessOutputHooks(session, output, {
                characterId: input.characterId,
                chatId: input.chatId,
                generation: { requestId: record.requestId, type: input.type, phase: 'afterGeneration' },
            });
            if (shouldStopGeneration(record)) return;
            output = outputHooks.text;
            mergeEffects(effects, outputHooks.effects);
            setFinalText(record, output);
            setFinalReasoning(record, reasoning);
            mergeEffects(effects, await emitHeadlessEvent(session, 'generation_completed', { requestId: record.requestId, status: 'done' }));
            if (shouldStopGeneration(record)) return;
            recordPluginEvents(record, effects.events);
            try { persistMacroEffects(session, chatPath, chat, formatted.macroEffects); } catch {
                throw new ApiError(500, 'unknown', 'The provider completed but output variable effects could not be confirmed. Inspect the retained generation before sending again; no request was replayed.');
            }
            // Persist plugin settings BEFORE the terminal event so a client that
            // observes `done` can immediately read back the extension settings.
            persistPluginSettings(session, effects.settingsPatch);

            if (input.type === 'quiet') {
                complete(record, {
                    characterId: input.characterId,
                    chatId: input.chatId,
                    messageIndex: null,
                    text: output,
                    reasoning,
                    warnings: built.warnings,
                    pluginEffects: summarizeEffects(effects),
                }, { committed: false });
            } else {
                const messageIndex = commitMessages(chatPath, chat, character.name, output, reasoning, input.type, previousReply, formatted.warnings.regexWarnings);
                complete(record, {
                    characterId: input.characterId,
                    chatId: input.chatId,
                    messageIndex,
                    message: { name: character.name, is_user: false, mes: output, extra: reasoning ? { reasoning } : {} },
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
function commitMessages(chatPath, chat, characterName, output, reasoning, type, previousReply = null, regexWarnings = []) {
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
    if (regexWarnings.length) {
        const message = chat.at(-1);
        message.extra ??= {};
        message.extra.native_regex_warnings = [...new Set([...(message.extra.native_regex_warnings ?? []), ...regexWarnings])].slice(0, 32);
        if (message.swipe_info?.[message.swipe_id]) message.swipe_info[message.swipe_id].extra = { ...message.extra };
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
