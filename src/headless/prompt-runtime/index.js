import { ApiError } from '../contract.js';
import { promptManagerConfiguration, PROMPT_MARKERS, validatePromptManager } from '../prompt-manager.js';
import { configurePromptRuntime, oai_settings } from './platform.js';
import { prepareOpenAIMessages, nativeChatDefaults, openai_messages_count } from './generated/engine.js';
import { countTokensOpenAIAsync, getTokenizerModel } from './generated/tokenizers.js';
import { setOpenAIMessages, lastContextMessageId } from './generated/history.js';
import { defaultReasoningSettings, applyPromptReasoning } from './generated/reasoning.js';

const builtin = new Set([...PROMPT_MARKERS, 'main', 'nsfw', 'jailbreak', 'enhanceDefinitions', 'impersonate', 'quietPrompt', 'groupNudge', 'bias']);
function settingsForContext(session, context) {
    const config = promptManagerConfiguration(session.settings);
    validatePromptManager(config);
    const settings = { ...nativeChatDefaults, ...session.settings.oai_settings };
    settings.prompts = config.prompts.map(prompt => ({ ...prompt, system_prompt: prompt.system_prompt ?? builtin.has(prompt.identifier), injection_position: prompt.injection_position ?? 0 }));
    settings.prompt_order = [{ character_id: 100001, order: config.order }];
    settings.openai_max_context = context.frame.maxContext;
    settings.openai_max_tokens = context.frame.maxResponse;
    settings[settings.chat_completion_source === 'custom' ? 'custom_model' : 'openai_model'] = context.frame.model;
    if (!Number.isSafeInteger(settings.openai_max_context) || !Number.isSafeInteger(settings.openai_max_tokens) || settings.openai_max_tokens < 1 || settings.openai_max_context <= settings.openai_max_tokens) throw new ApiError(422, 'validation', 'Context tokens must exceed the positive reserved response budget.');
    return settings;
}

/** Native transport bindings around actual source classes and packing routines. */
export async function assembleSourcePrompt(session, context, fields, history, examples, regex, { type = 'normal', input = '', preview = false, requireNewestUser = false } = {}) {
    context.frame.powerUser.reasoning = { ...defaultReasoningSettings, ...context.frame.powerUser.reasoning };
    if (Number(context.frame.powerUser.persona_description_position) === 1) context.frame.powerUser.persona_description_position = 0;
    const warnings = [];
    const frame = { context, oai: settingsForContext(session, context), warnings, regex };
    const manager = configurePromptRuntime(frame);
    const rows = applyPromptReasoning(history.map(message => ({ ...message })), type);
    const messages = setOpenAIMessages(rows);
    try {
        const [chat, counts] = await prepareOpenAIMessages({
            name2: context.frame.characterName,
            charDescription: fields.description, charPersonality: fields.personality, scenario: fields.scenario,
            worldInfoBefore: fields.wiBefore, worldInfoAfter: fields.wiAfter,
            bias: '', type, quietPrompt: ['quiet', 'continue'].includes(type) ? input : '', quietImage: null,
            extensionPrompts: context.frame.extensionPrompts, cyclePrompt: type === 'continue' ? rows.at(-1)?.mes : null,
            systemPromptOverride: fields.system, jailbreakPromptOverride: fields.jailbreak,
            messages, messageExamples: examples,
        }, !!preview);
        if (frame.unsupportedMedia) throw new ApiError(422, 'unsupported', 'Native media input is not configured.');
        if (requireNewestUser && history.at(-1)?.mes && manager.messages.hasItemWithIdentifier('chatHistory')) {
            const latest = messages.findLastIndex(message => !message.injected);
            const retained = manager.messages.flatten().some(message => message.identifier === `chatHistory-${latest + 1}`);
            if (!retained) throw new ApiError(422, 'validation', 'The newest input cannot fit in the configured context after mandatory prompts. Increase context or reduce prompt/response tokens; no model request was sent.');
        }
        context.frame.metadata.lastInContextMessageId = lastContextMessageId(context.frame.chat.length, openai_messages_count, type);
        const completion = manager.messages;
        const usedTokens = completion.getTokens() + 3;
        const segments = completion.getCollection().filter(Boolean).map(item => ({
            name: item.identifier, role: item.role ?? 'system',
            content: ['chatHistory', 'dialogueExamples'].includes(item.identifier) ? String(item.collection?.length ?? 0) : typeof item.content === 'string' ? item.content : item.getChat().map(message => message.content).join('\n'),
        }));
        return {
            messages: chat, segments,
            tokenBudget: { contextTokens: oai_settings.openai_max_context, responseTokens: oai_settings.openai_max_tokens, usedTokens, allocatedTokens: manager.tokenUsage + 3, remainingTokens: oai_settings.openai_max_context - oai_settings.openai_max_tokens - usedTokens, tokenizerModel: getTokenizerModel(), messageCount: chat.length, counts: Object.fromEntries(Object.entries(counts).filter(([key, value]) => key !== 'undefined' && Number.isFinite(value))) },
            warnings,
        };
    } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error.name === 'TokenBudgetExceeded') throw new ApiError(422, 'validation', 'Mandatory prompts exceed the available context budget. Increase context or reduce prompt/response tokens.');
        if (error.name === 'InvalidCharacterName') throw new ApiError(422, 'validation', 'A prompt message name cannot be represented by the selected Chat Completion format.');
        throw error;
    }
}

/** Count the final outbound packet without expanding macros or replaying hooks. */
export async function auditSourcePrompt(session, request) {
    const settings = { ...nativeChatDefaults, ...session.settings.oai_settings };
    settings[settings.chat_completion_source === 'custom' ? 'custom_model' : 'openai_model'] = request.model;
    const contextTokens = Number(settings.openai_max_context), responseTokens = Number(request.max_completion_tokens ?? request.max_tokens ?? settings.openai_max_tokens);
    if (!Number.isSafeInteger(contextTokens) || !Number.isSafeInteger(responseTokens) || responseTokens < 1 || contextTokens <= responseTokens) throw new ApiError(422, 'validation', 'The outgoing response budget does not fit the configured context.');
    configurePromptRuntime({ oai: settings, context: null, warnings: [] });
    let usedTokens = 3;
    for (const message of request.messages) {
        if (typeof message.content !== 'string' || message.tool_calls) throw new ApiError(422, 'unsupported', 'Media/tool prompt auditing requires the corresponding native authorization/input lifecycle.');
        usedTokens += await countTokensOpenAIAsync(message);
    }
    if (usedTokens + responseTokens > contextTokens) throw new ApiError(422, 'validation', 'The final outgoing prompt exceeds the configured context after request hooks. No model request was sent.');
    return { contextTokens, responseTokens, usedTokens, remainingTokens: contextTokens - responseTokens - usedTokens, tokenizerModel: getTokenizerModel(), messageCount: request.messages.length };
}
