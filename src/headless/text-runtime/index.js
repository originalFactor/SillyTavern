import { ApiError } from '../contract.js';
import { configureTextRuntime, getTokenCountAsync, setInContextMessages } from './platform.js';
import { defaultContextSettings, defaultInstructSettings } from './generated/defaults.js';
import { packTextPrompt } from './generated/packing.js';
import { formatInstructModeExamples, getInstructStoppingSequences } from './generated/instruct.js';
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
    type = 'normal', input = '', preview = false, tokenizer = null, requireNewestUser = false, textSettings = {}, extensionSettings = {}, regex = null,
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
    const runtime = { context, tokenizer, warnings, textSettings, extensionSettings, regex };
    configureTextRuntime(runtime);
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
    return {
        prompt: result.prompt,
        negativePrompt: result.negativePrompt, guidanceScale: result.guidanceScale,
        stops: power.instruct.enabled ? getInstructStoppingSequences() : [],
        tokenBudget: {
            contextTokens: state.maxContext, responseTokens: state.maxResponse, usedTokens,
            remainingTokens: state.maxContext - state.maxResponse - Math.max(usedTokens, negativeTokens ?? 0),
            tokenizerModel: tokenizer, messageCount: result.historyCount, exampleCount: result.exampleCount, negativeTokens,
        },
        warnings,
    };
}
