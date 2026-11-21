import { ApiError } from '../contract.js';
import { configureTextRuntime, getTokenCountAsync, setInContextMessages } from './platform.js';
import { defaultContextSettings, defaultInstructSettings } from './generated/defaults.js';
import { packTextPrompt } from './generated/packing.js';
import { formatInstructModeExamples } from './generated/instruct.js';
import { buildNativeSampler, defaultTextSettings } from './generated/sampler.js';
import { getStoppingStrings, setNativeEphemeralStops } from './generated/stops.js';
import { getTokenizerBestMatch, tokenizers, TOKENIZER_URLS } from './generated/tokenizers.js';
import { applyPromptReasoning } from './generated/reasoning.js';
import { collapseNewlines } from './generated/utilities.js';

export function selectLocalTextTokenizer(context) {
    const choice = context.frame.powerUser.tokenizer ?? tokenizers.BEST_MATCH;
    const selected = choice === tokenizers.BEST_MATCH ? getTokenizerBestMatch('textgenerationwebui') : choice;
    if (!Number.isInteger(selected) || [tokenizers.NONE, tokenizers.OPENAI, tokenizers.API_CURRENT, tokenizers.API_KOBOLD, tokenizers.API_TEXTGENERATIONWEBUI].includes(selected)) throw new ApiError(422, 'unsupported', 'Choose a supported local text tokenizer; remote tokenizers and character estimates are not connected.');
    const model = /^\/api\/tokenizers\/([^/]+)\/encode$/.exec(TOKENIZER_URLS[selected]?.encode ?? '')?.[1];
    if (!model) throw new ApiError(422, 'unsupported', 'The selected text tokenizer cannot encode locally.');
    return model;
}

/** Source string fitter. This adapter does not admit a provider request. */
export async function assembleTextPrompt(context, fields, history, examples, {
    type = 'normal', input = '', preview = false, tokenizer = null, requireNewestUser = false, textSettings = {}, extensionSettings = {}, regex = null, sampler = false, overrides = {},
} = {}) {
    const state = context.frame;
    const power = state.powerUser;
    if (state.mainApi !== 'textgenerationwebui') throw new ApiError(422, 'unsupported', 'This string prompt adapter requires a text-completion profile.');
    if (!['normal', 'regenerate', 'continue', 'quiet'].includes(type)) throw new ApiError(422, 'unsupported', 'This native string generation kind is not connected.');
    if (!Number.isSafeInteger(state.maxContext) || !Number.isSafeInteger(state.maxResponse) || state.maxResponse < 1 || state.maxContext <= state.maxResponse) throw new ApiError(422, 'validation', 'Context tokens must exceed the positive reserved response budget.');
    power.instruct = { ...defaultInstructSettings, ...power.instruct };
    power.context = { ...defaultContextSettings, ...power.context };
    power.token_padding ??= 0;
    const warnings = [];
    const samplerSettings = { ...defaultTextSettings, ...textSettings };
    for (const [field, override] of [['temp', 'temperature'], ['top_p', 'topP'], ['freq_pen', 'frequencyPenalty'], ['presence_pen', 'presencePenalty']]) if (overrides[override] !== undefined) samplerSettings[field] = overrides[override];
    const runtime = { context, tokenizer, warnings, textSettings: samplerSettings, extensionSettings, regex };
    configureTextRuntime(runtime);
    setNativeEphemeralStops(overrides.stop ?? []);
    tokenizer ??= selectLocalTextTokenizer(context);
    runtime.tokenizer = tokenizer;
    const rawExamples = examples.slice();
    const formattedExamples = power.instruct.enabled
        ? formatInstructModeExamples(rawExamples, state.userName, state.characterName)
        : rawExamples;
    const result = await packTextPrompt({
        coreChat: applyPromptReasoning(structuredClone(history), type), chat: state.chat,
        description: fields.description, personality: fields.personality, persona: fields.persona,
        scenario: fields.scenario, system: fields.system, jailbreak: fields.jailbreak,
        worldInfoBefore: fields.wiBefore, worldInfoAfter: fields.wiAfter,
        mesExamplesArray: formattedExamples, mesExamplesRawArray: rawExamples,
        type, dryRun: preview, quiet_prompt: ['quiet', 'continue'].includes(type) ? input : '',
        force_name2: !!power.always_force_name2,
        this_max_context: state.maxContext - state.maxResponse,
    });
    let usedTokens = await getTokenCountAsync(result.prompt, power.token_padding);
    // Source initially sums individual message tokens. BPE boundaries and an
    // output head can make the final joined string larger. Refit frozen rendered
    // pieces, never replaying macros or source events. Preserve the last/control
    // message; an oversized newest input must fail rather than disappear.
    const layout = result.nativeLayouts.positive;
    const render = () => {
        const joined = [layout.story, layout.examples.join(''), layout.prefix, layout.messages.map(item => item.text).join(''), layout.continuation].join('').replace(/\r/gm, '');
        return power.collapse_newlines ? collapseNewlines(joined) : joined;
    };
    if (result.guidanceScale === null && render() === result.prompt) {
        while (usedTokens + state.maxResponse > state.maxContext) {
            if (!power.pin_examples && layout.examples.length) layout.examples.pop();
            else if (layout.messages.length > 1) layout.messages.shift();
            else break;
            result.prompt = render();
            usedTokens = await getTokenCountAsync(result.prompt, power.token_padding);
        }
        result.historyCount = layout.messages.length;
        result.exampleCount = layout.examples.length;
        setInContextMessages(layout.messages.filter(item => !item.injected).length, type);
        if (type !== 'continue') result.newestHistoryIncluded = layout.messages.some(item => item.original === result.newestFormatted);
    }
    const negativeTokens = result.negativePrompt === null ? null : await getTokenCountAsync(result.negativePrompt, power.token_padding);
    // Browser assembly permits an oversized mandatory story to remain visible.
    // Native dispatch must fail rather than send that inspect-only partial fit.
    if (result.effectiveContext <= 0 || Math.max(usedTokens, negativeTokens ?? 0) + state.maxResponse > state.maxContext) throw new ApiError(422, 'validation', 'Mandatory string prompts exceed the available context budget. No model request was sent.');
    if (requireNewestUser && !result.newestHistoryIncluded) throw new ApiError(422, 'validation', 'The newest input does not fit the string prompt budget. No model request was sent.');
    const generationData = sampler ? await buildNativeSampler(samplerSettings, state.model || undefined, result.prompt, state.maxResponse, false, type === 'continue', result.guidanceScale === null ? null : { guidanceScale: { value: result.guidanceScale }, negativePrompt: result.negativePrompt }, type) : null;
    return {
        prompt: result.prompt,
        negativePrompt: result.negativePrompt, guidanceScale: result.guidanceScale,
        sampler: generationData,
        stops: generationData?.stop ?? getStoppingStrings(false, type === 'continue'),
        tokenBudget: {
            contextTokens: state.maxContext, responseTokens: state.maxResponse, usedTokens,
            remainingTokens: state.maxContext - state.maxResponse - Math.max(usedTokens, negativeTokens ?? 0),
            tokenizerModel: tokenizer, messageCount: result.historyCount, exampleCount: result.exampleCount, negativeTokens,
        },
        warnings,
    };
}

/** Token-only final audit: no macro expansion, scripts, vault or connection data. */
export async function auditStringPrompt(session, request) {
    const { encodeLocalTextTokens } = await import('../../endpoints/tokenizers.js');
    const contextTokens = Number(session.settings.max_context), responseTokens = Number(request.max_tokens ?? request.max_new_tokens ?? session.settings.amount_gen);
    if (!Number.isSafeInteger(contextTokens) || !Number.isSafeInteger(responseTokens) || responseTokens < 1 || responseTokens >= contextTokens) throw new ApiError(422, 'validation', 'The text response budget does not fit its context.');
    if (typeof request.prompt !== 'string' || !request.prompt.length) throw new ApiError(422, 'validation', 'The final text prompt must be a nonempty string.');
    const textSettings = { type: session.settings.textgenerationwebui_settings?.type };
    for (const field of Object.keys(defaultTextSettings).filter(key => key.endsWith('_model'))) textSettings[field] = request.model ?? '';
    const state = { powerUser: session.settings.power_user ?? {}, extensionPrompts: {}, metadata: {}, chat: [], characters: [], mainApi: 'textgenerationwebui', maxContext: contextTokens };
    configureTextRuntime({ context: { frame: state }, textSettings, warnings: [] });
    const tokenizer = selectLocalTextTokenizer({ frame: state });
    const padding = state.powerUser.token_padding ?? 0;
    if (!Number.isSafeInteger(padding) || padding < 0) throw new ApiError(422, 'validation', 'Token padding must be a nonnegative integer.');
    const usedTokens = (await encodeLocalTextTokens(request.prompt, tokenizer)).length + padding;
    const negativeTokens = typeof request.negative_prompt === 'string' && request.negative_prompt ? (await encodeLocalTextTokens(request.negative_prompt, tokenizer)).length + padding : null;
    if (Math.max(usedTokens, negativeTokens ?? 0) + responseTokens > contextTokens) throw new ApiError(422, 'validation', 'The final outgoing text prompt exceeds context after request hooks. No model request was sent.');
    return { contextTokens, responseTokens, usedTokens, negativeTokens, remainingTokens: contextTokens - responseTokens - Math.max(usedTokens, negativeTokens ?? 0), tokenizerModel: tokenizer };
}
