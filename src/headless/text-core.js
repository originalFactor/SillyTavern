import { createMacroContext } from './macros.js';
import { nativeRegex, messagePlacement, regex_placement } from './regex-runtime.js';
import { ApiError } from './contract.js';

/** Shared greeting/storage/edit/display semantics, isolated from provider secrets. */
export function evaluateNativeText(session, character, chat, options) {
    const mode = options.mode;
    const context = createMacroContext(session, character, chat, { ...options, preview: mode === 'display' || mode === 'edit' || mode === 'append' });
    const regex = nativeRegex(session, context, options.characterId);
    let text, reasoning;
    if (mode === 'input') {
        text = context.expand(regex.apply(options.text, regex_placement.USER_INPUT));
    } else if (mode === 'greeting') {
        text = regex.apply(context.expand(options.text), regex_placement.AI_OUTPUT);
    } else if (mode === 'output') {
        text = regex.apply(options.text, regex_placement.AI_OUTPUT);
        reasoning = regex.apply(options.reasoning ?? '', regex_placement.REASONING);
    } else if (mode === 'edit' || mode === 'append') {
        const message = options.message ?? {};
        text = regex.apply(message.mes, messagePlacement(message), { isEdit: mode === 'edit', characterOverride: message.extra?.type === 'narrator' ? undefined : message.name });
        text = context.expand(text);
    } else if (mode === 'display') {
        const usable = chat.map((message, index) => ({ message, index })).filter(row => typeof row.message?.mes === 'string' && !row.message.is_system);
        const messages = options.messages.map(message => {
            const offset = usable.findIndex(row => row.index === message.index);
            const depth = offset < 0 ? undefined : usable.length - offset - 1;
            return {
                index: message.index,
                display: regex.apply(message.mes, messagePlacement(message), { isMarkdown: true, characterOverride: message.name, depth }),
                displayReasoning: regex.apply(message.extra?.reasoning ?? '', regex_placement.REASONING, { isMarkdown: true, characterOverride: message.name, depth }),
            };
        });
        return { messages, warnings: regex.warnings, discardedVariableEffects: context.frame.localDirty || context.frame.globalDirty };
    } else throw new ApiError(400, 'validation', 'Unknown native text evaluation operation.');
    return { text, reasoning, macroEffects: context.effects(), warnings: { macroWarnings: context.frame.warnings, regexWarnings: regex.warnings } };
}
