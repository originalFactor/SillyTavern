import { ApiError } from './contract.js';
import { removeGroupGenerationBatch, selectGroupMembers } from './group-activation.js';
import { loadGroupCharacters, resolveGroupChat } from './group-management.js';
import { beginGeneration, complete, endGeneration, fail, prepareGroupProgress, recordGroupCommit, recordPluginEvents, shouldStopGeneration, stage, withChatLock } from './generation-store.js';
import { persistMacroEffects } from './macros.js';
import { auditPrompt, buildPrompt, runNativeText } from './prompt.js';
import { applyHeadlessHooks, applyHeadlessOutputHooks, emitHeadlessEvent, mergeEffects, persistPluginSettings } from './plugin-runtime.js';
import { createCharacterMessage, createUserMessage, writeChat } from './session.js';
import { runSessionCompletion } from './provider.js';
import { commitMessages } from './runtime.js';

/** Execute an admitted group turn in speaker order. */
export async function runGroupGeneration(request, session, record, input) {
    if (!beginGeneration(record)) return;
    let transcriptWriteAttempted = false;
    try {
        const type = input.type ?? 'normal';
        if (!['normal', 'regenerate', 'continue'].includes(type)) throw new ApiError(422, 'unsupported', 'Unsupported group generation type.');
        const generationType = type === 'regenerate' ? 'normal' : type;
        const effects = { events: [], settingsPatch: {}, extensionPrompts: [], quietPrompts: [], warnings: [] };
        mergeEffects(effects, await emitHeadlessEvent(session, 'generation_started', { type: generationType, requestId: record.requestId }));
        if (shouldStopGeneration(record)) return;
        const initial = await resolveGroupChat(session, input.groupId, input.chatId);
        await withChatLock(initial.file, async () => {
            if (shouldStopGeneration(record)) return;
            const { group, chat, file } = await resolveGroupChat(session, input.groupId, input.chatId);
            const characters = await loadGroupCharacters(session, group);
            if (shouldStopGeneration(record)) return;
            if (type !== 'normal' && (chat.length <= 1 || chat.at(-1).is_user || chat.at(-1).is_system || typeof chat.at(-1).mes !== 'string')) {
                throw new ApiError(409, 'conflict', 'The last message must be an assistant reply.');
            }
            const previousGenerationIds = chat.map(message => message.extra?.gen_id);
            if (type === 'regenerate') removeGroupGenerationBatch(chat);
            const members = selectGroupMembers({ group, characters, chat, input: type === 'regenerate' ? '' : input.input ?? '', type: generationType });
            if (type === 'continue' && members.length !== 1) throw new ApiError(409, 'conflict', 'The last speaker is not available in this group.');
            prepareGroupProgress(record, members, previousGenerationIds);
            if (type === 'normal' && input.input) chat.push(createUserMessage(session, input.input));
            if (!members.length) {
                let macroEffects;
                if (type === 'normal' && input.input) {
                    const character = characters[0];
                    const formatted = await runNativeText(session, character?.data ?? {}, chat.slice(0, -1), {
                        mode: 'input', text: input.input, input: input.input, type,
                        characterId: character?.avatar.slice(0, -4) ?? '', chatId: input.chatId,
                        nativeContext: input.nativeContext, groupContext: { group, characters, characterIndex: 0 },
                    });
                    if (shouldStopGeneration(record)) return;
                    chat.at(-1).mes = formatted.text;
                    chat.at(-1).swipes = [formatted.text];
                    macroEffects = formatted.macroEffects;
                }
                mergeEffects(effects, await emitHeadlessEvent(session, 'generation_completed', { requestId: record.requestId, status: 'done' }));
                if (shouldStopGeneration(record)) return;
                recordPluginEvents(record, effects.events.splice(0));
                persistPluginSettings(session, effects.settingsPatch);
                if ((type === 'normal' && input.input) || type === 'regenerate') {
                    transcriptWriteAttempted = true;
                    persistMacroEffects(session, file, chat, macroEffects);
                    writeChat(file, chat);
                }
                complete(record, { groupId: input.groupId, chatId: input.chatId }, { committed: (type === 'normal' && Boolean(input.input)) || type === 'regenerate' });
                return;
            }
            for (const member of members) {
                if (shouldStopGeneration(record)) return;
                const characterIndex = characters.findIndex(character => character.avatar === member);
                const character = characters[characterIndex];
                const characterId = member.slice(0, -4);
                const groupContext = { group, characters, characterIndex };
                stage(record, 'prompt');
                let built = await buildPrompt(session, character.data, chat, {
                    type: generationType, input: type === 'regenerate' ? '' : input.input, overrides: input.overrides ?? {},
                    characterId, chatId: input.chatId, nativeContext: input.nativeContext,
                    groupContext,
                    stageUserInput: type === 'normal' && Boolean(input.input) && record.groupProgress.completed.length === 0,
                });
                if (shouldStopGeneration(record)) return;
                if (built.stagedUserMessage !== undefined) {
                    chat.at(-1).mes = built.stagedUserMessage;
                    chat.at(-1).swipes = [built.stagedUserMessage];
                }
                persistMacroEffects(session, file, chat, built.macroEffects);
                const hooked = await applyHeadlessHooks(session, built, {
                    characterId, chatId: input.chatId, characterName: character.name, chat,
                    chatMetadata: chat[0]?.chat_metadata ?? {},
                    generation: { requestId: record.requestId, type: generationType, phase: 'prompt' },
                });
                if (shouldStopGeneration(record)) return;
                built = hooked.prompt;
                mergeEffects(effects, hooked.effects);
                recordPluginEvents(record, effects.events.splice(0));
                built.warnings.tokenBudget = await auditPrompt(session, built.providerRequest);
                if (shouldStopGeneration(record)) return;
                stage(record, 'provider');
                const result = await runSessionCompletion(request, built.providerRequest, record, session);
                if (shouldStopGeneration(record)) return;
                const formatted = await runNativeText(session, character.data, chat, {
                    mode: 'output', text: result.text, reasoning: result.reasoning, type: generationType,
                    characterId, chatId: input.chatId, nativeContext: input.nativeContext, groupContext,
                });
                if (shouldStopGeneration(record)) return;
                const output = await applyHeadlessOutputHooks(session, formatted.text, {
                    characterId, chatId: input.chatId,
                    generation: { requestId: record.requestId, type: generationType, phase: 'afterGeneration' },
                });
                if (shouldStopGeneration(record)) return;
                mergeEffects(effects, output.effects);
                if (record.groupProgress.completed.length === members.length - 1) {
                    mergeEffects(effects, await emitHeadlessEvent(session, 'generation_completed', { requestId: record.requestId, status: 'done' }));
                    if (shouldStopGeneration(record)) return;
                }
                recordPluginEvents(record, effects.events.splice(0));
                persistMacroEffects(session, file, chat, formatted.macroEffects);
                persistPluginSettings(session, effects.settingsPatch);
                effects.settingsPatch = {};
                let messageIndex;
                if (generationType === 'normal') {
                    const message = createCharacterMessage(character.name, output.text, formatted.reasoning);
                    message.original_avatar = member;
                    message.extra.gen_id = record.groupProgress.generationId;
                    if (formatted.warnings.regexWarnings.length) {
                        message.extra.native_regex_warnings = [...new Set(formatted.warnings.regexWarnings)].slice(0, 32);
                    }
                    chat.push(message);
                    transcriptWriteAttempted = true;
                    writeChat(file, chat);
                    messageIndex = chat.length - 1;
                } else {
                    transcriptWriteAttempted = true;
                    messageIndex = commitMessages(file, chat, character.name, output.text, formatted.reasoning, type, null, formatted.warnings.regexWarnings);
                }
                recordGroupCommit(record, member, messageIndex);
            }
            complete(record, { groupId: input.groupId, chatId: input.chatId, groupProgress: record.groupProgress });
        });
    } catch (error) {
        if (shouldStopGeneration(record)) return;
        const code = record.providerDispatched || transcriptWriteAttempted ? 'unknown' : error instanceof ApiError ? error.code : 'internal';
        const message = error instanceof ApiError ? error.message : 'Group generation failed. Inspect the chat before sending again.';
        fail(record, code, message, false);
    } finally {
        endGeneration(record);
    }
}
