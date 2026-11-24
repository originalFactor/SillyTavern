import { ApiError } from '../contract.js';
import { promptManagerConfiguration, PROMPT_MARKERS, validatePromptManager } from '../prompt-manager.js';
import { configurePromptRuntime, getChatCompletionModel, oai_settings } from './platform.js';
import { prepareOpenAIMessages, nativeChatDefaults, openai_messages_count } from './compat/engine.js';
import { setOpenAIMessages, lastContextMessageId } from './compat/history.js';
import { defaultReasoningSettings, applyPromptReasoning } from './compat/reasoning.js';

const builtin = new Set([...PROMPT_MARKERS, 'main', 'nsfw', 'jailbreak', 'enhanceDefinitions', 'impersonate', 'quietPrompt', 'groupNudge', 'bias']);
function settingsForContext(session: any, context: any) {
    const config = promptManagerConfiguration(session.settings);
    validatePromptManager(config);
    const settings = { ...nativeChatDefaults, ...session.settings.oai_settings };
    settings.prompts = config.prompts.map(prompt => ({ ...prompt, system_prompt: prompt.system_prompt ?? builtin.has(prompt.identifier), injection_position: prompt.injection_position ?? 0 }));
    settings.prompt_order = [{ character_id: 100001, order: config.order }];
    settings.openai_max_context = context.frame.maxContext;
    settings.openai_max_tokens = context.frame.maxResponse;
    if (settings.chat_completion_source === 'custom') settings.custom_model = context.frame.model;
    else settings.openai_model = context.frame.model;
    if (!Number.isSafeInteger(settings.openai_max_context) || !Number.isSafeInteger(settings.openai_max_tokens) || settings.openai_max_tokens < 1 || settings.openai_max_context <= settings.openai_max_tokens) throw new ApiError(422, 'validation', 'Context tokens must exceed the positive reserved response budget.');
    return settings;
}

/** Native transport bindings around actual source classes and packing routines. */
export async function assembleSourcePrompt(session: any, context: any, fields: any, history: any, examples: any, regex: any, { type = 'normal', input = '', preview = false, requireNewestUser = false }: Record<string, any> = {}) {
    context.frame.powerUser.reasoning = { ...defaultReasoningSettings, ...context.frame.powerUser.reasoning };
    if (Number(context.frame.powerUser.persona_description_position) === 1) context.frame.powerUser.persona_description_position = 0;
    const warnings: any[] = [];
    const configuredModel = String(({
        custom: session.settings.oai_settings?.custom_model,
    } as Record<string, any>)[session.settings.oai_settings?.chat_completion_source] ?? session.settings.oai_settings?.openai_model ?? '');
    const frame: Record<string, any> = { context, oai: settingsForContext(session, context), reasoningOriginModel: configuredModel, warnings, regex };
    const manager = configurePromptRuntime(frame);
    const currentApi = String(session.settings.oai_settings?.chat_completion_source ?? 'openai');
    const currentModel = String(getChatCompletionModel());
    const rows = applyPromptReasoning(history.map((message: any) => {
        const copy = { ...message };
        const originApi = copy.extra?.api;
        const originModel = copy.extra?.model;
        if (originApi !== currentApi || originModel !== currentModel) {
            if (copy.extra?.reasoning || copy.extra?.reasoning_signature) {
                copy.extra = { ...copy.extra, reasoning: '', reasoning_signature: null };
            }
            return copy;
        }
        return copy;
    }), type);
    if (frame.oai.function_calling === true) {
        for (const row of rows) {
            if (!Array.isArray(row.extra?.tool_invocations)) continue;
            if (row.extra.tool_invocations.length === 0) throw new ApiError(422, 'validation', 'A stored tool invocation is invalid. No model request was sent.');
            const ids = new Set();
            for (const invocation of row.extra.tool_invocations) {
                if (!invocation || typeof invocation.id !== 'string' || !invocation.id || ids.has(invocation.id) || typeof invocation.name !== 'string' || !invocation.name || typeof invocation.parameters !== 'string' || typeof invocation.result !== 'string') throw new ApiError(422, 'validation', 'A stored tool invocation is invalid. No model request was sent.');
                ids.add(invocation.id);
            }
        }
    }
    const messages = setOpenAIMessages(rows);
    try {
        const [chat] = await prepareOpenAIMessages({
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
            const latest = messages.findLastIndex((message: any) => !message.injected);
            const retained = manager.messages.flatten().some((message: any) => message.identifier === `chatHistory-${latest + 1}`);
            if (!retained) throw new ApiError(422, 'validation', 'The newest input cannot fit in the configured context after mandatory prompts. Increase context or reduce prompt/response tokens; no model request was sent.');
        }
        context.frame.metadata.lastInContextMessageId = lastContextMessageId(context.frame.chat.length, openai_messages_count, type);
        const completion = manager.messages;
        const segments = completion.getCollection().filter(Boolean).map((item: any) => ({
            name: item.identifier, role: item.role ?? 'system',
            content: ['chatHistory', 'dialogueExamples'].includes(item.identifier) ? String(item.collection?.length ?? 0) : typeof item.content === 'string' ? item.content : item.getChat().map((message: any) => message.content).join('\n'),
        }));
        return {
            messages: chat, segments,
            warnings,
        };
    } catch (error: any) {
        if (error instanceof ApiError) throw error;
        if (error.name === 'InvalidCharacterName') throw new ApiError(422, 'validation', 'A prompt message name cannot be represented by the selected Chat Completion format.');
        throw error;
    }
}

