import { createMacroContext } from './macros.js';
import { upstreamMacroScript } from './macro-runtime/index.js';
import { ApiError } from './contract.js';
import { nativeRegex, messagePlacement, regex_placement } from './regex-runtime.js';
import { listExtensions } from './prompt-settings.js';
import { scanWorldInfo } from './world-info-runtime/index.js';
import { assembleSourcePrompt } from './prompt-runtime/index.js';

/** One source-derived preparation pipeline for preview and admitted generation. */
export async function buildPromptInline(session, character, chat, { type, input = '', overrides = {}, ...options }) {
    const settings = session.settings;
    if (settings.main_api !== 'openai' || !['openai', 'custom'].includes(settings.oai_settings?.chat_completion_source ?? 'openai')) throw new ApiError(422, 'unsupported', 'This native completion source is not supported.');
    const personaPosition = Number(settings.power_user?.persona_description_position ?? 0);
    if (![0, 1, 2, 3, 4, 9].includes(personaPosition) && settings.power_user?.persona_description) throw new ApiError(422, 'unsupported', 'Unknown Persona placement.');
    const context = createMacroContext(session, character, chat, { type, input, overrides, extensions: options.extensions ?? listExtensions(session), ...options });
    const regex = nativeRegex(session, context, options.characterId);
    let stagedUserMessage;
    if (options.stageUserInput) {
        const last = chat.at(-1);
        if (!last?.is_user || last.mes !== input) throw new ApiError(409, 'conflict', 'Staged user message changed before preparation.');
        context.frame.chat.pop();
        stagedUserMessage = context.expand(regex.apply(input, regex_placement.USER_INPUT));
        last.mes = stagedUserMessage; last.swipes = [stagedUserMessage];
        context.frame.chat.push(structuredClone(last));
    }
    const fields = context.fields();
    if (fields.charDepthPrompt) {
        const depth = character.extensions?.depth_prompt?.depth ?? 4;
        if (!Number.isInteger(depth) || depth < 0 || depth > 10000) throw new ApiError(422, 'validation', 'Character depth prompt must have an integer depth in 0..10000.');
        const role = Math.max(0, ['system', 'user', 'assistant'].indexOf(character.extensions?.depth_prompt?.role ?? 'system'));
        context.frame.extensionPrompts.DEPTH_PROMPT = { value: fields.charDepthPrompt, position: 1, depth, scan: !!session.extensionSettings?.note?.allowWIScan, role };
    }
    const worldInfo = await scanWorldInfo(session, character, chat, context, fields, { type, input, ...options });
    const transcript = chat.filter(message => typeof message?.mes === 'string' && !message.is_system);
    // Source fitting owns clipping. Never replace token budgets with row counts.
    const history = transcript.map((message, index) => ({ ...message, mes: regex.apply(index === 0 ? context.expand(message.mes) : message.mes, messagePlacement(message), { isPrompt: true, depth: transcript.length - index - (type === 'continue' ? 2 : 1) }) }));
    const blocks = context.examples(fields.mesExamples ?? '');
    for (const entry of worldInfo.examples) {
        const parsed = context.examples(context.expand(entry.content));
        if (entry.position === 0) blocks.unshift(...parsed); else blocks.push(...parsed);
    }
    const examples = blocks.map(example => context.run(() => context.frame.exampleParser(upstreamMacroScript.substituteParams(example))));
    const built = await assembleSourcePrompt(session, context, { ...fields, wiBefore: worldInfo.before, wiAfter: worldInfo.after }, history, examples, regex, { type, input, preview: !!options.preview, requireNewestUser: !!options.stageUserInput });
    return {
        messages: built.messages, segments: built.segments, stagedUserMessage,
        macroEffects: context.effects(),
        warnings: {
            worldInfoActivated: worldInfo.activated, worldInfoScanner: true, worldInfoWarnings: worldInfo.warnings,
            macroWarnings: context.frame.warnings, regexWarnings: regex.warnings,
            macroStateChanges: { local: context.frame.localDirty, global: context.frame.globalDirty },
            tokenBudget: built.tokenBudget, promptAssemblyWarnings: built.warnings,
            promptManagerOrdering: true, sourcePromptAssembly: true, promptTokenBudget: true,
            promptManagerPresets: false, instructMode: false, advancedMacros: false, upstreamMacroEngine: true,
            extensionPrompts: false, groupChats: false, swipes: true,
        },
    };
}
