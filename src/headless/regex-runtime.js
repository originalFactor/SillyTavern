import { getRegexedString, regex_placement } from './world-info-runtime/generated/regex.js';
import { configure } from './world-info-runtime/platform.js';
export { regex_placement };

/** Source-derived regex executes only in the serialized, bounded evaluator. */
export function nativeRegex(session, context, characterId = '') {
    const extensionSettings = structuredClone(session.extensionSettings ?? {});
    extensionSettings.disabledExtensions ??= [];
    extensionSettings.regex = (extensionSettings.regex ?? []).map(script => normalize(script));
    const character = context.frame.characters[0]?.data;
    if (Array.isArray(character?.extensions?.regex_scripts)) character.extensions.regex_scripts = character.extensions.regex_scripts.map(normalize);
    const frame = {
        context, characterId, books: {}, settings: session.settings.world_info_settings,
        extensionSettings, diagnostics: [], loops: 0, tagMap: session.settings.tag_map ?? {},
        presetName: (!session.settings.main_api || session.settings.main_api === 'openai') ? session.settings.oai_settings?.preset_settings_openai : '',
        presetRegex: (!session.settings.main_api || session.settings.main_api === 'openai') ? (session.settings.oai_settings?.extensions?.regex_scripts ?? []).map(normalize) : [],
        diagnosticLabel: 'Regex evaluator reported an invalid expression or setting.',
    };
    return {
        apply(text, placement, options = {}) {
            configure(frame, getRegexedString);
            return context.run(() => getRegexedString(String(text ?? ''), placement, options));
        },
        warnings: frame.diagnostics,
    };
}
function normalize(script) {
    if (!script || typeof script !== 'object') return {};
    return { ...script, placement: Array.isArray(script.placement) ? script.placement.map(Number) : [Number(script.placement ?? 1)], replaceString: String(script.replaceString ?? ''), trimStrings: script.trimStrings ?? [], substituteRegex: script.substituteRegex ?? 0 };
}
export const messagePlacement = message => message.is_user ? regex_placement.USER_INPUT : message.extra?.type === 'narrator' ? regex_placement.SLASH_COMMAND : regex_placement.AI_OUTPUT;
