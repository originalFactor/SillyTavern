import { getRegexedString, regex_placement } from './world-info-runtime/generated/regex.js';
import { configure } from './world-info-runtime/platform.js';
export { regex_placement };

export function nativeRegexPreset(settings) {
    if (settings.main_api && !['openai', 'textgenerationwebui'].includes(settings.main_api)) return { presetName: '', presetRegex: [] };
    const isText = settings.main_api === 'textgenerationwebui';
    return {
        presetName: isText ? settings.textgenerationwebui_settings?.preset ?? '' : settings.oai_settings?.preset_settings_openai ?? '',
        presetRegex: (isText ? settings.textgenerationwebui_settings?.extensions?.regex_scripts : settings.oai_settings?.extensions?.regex_scripts) ?? [],
    };
}

/** Source-derived regex executes only in the serialized, bounded evaluator. */
export function nativeRegex(session, context, characterId = '') {
    const extensionSettings = structuredClone(session.extensionSettings ?? {});
    extensionSettings.disabledExtensions ??= [];
    extensionSettings.regex = (extensionSettings.regex ?? []).map(script => normalize(migrateGlobalRegex(script)));
    const character = context.frame.characters[context.frame.characterIndex ?? 0]?.data;
    if (Array.isArray(character?.extensions?.regex_scripts)) character.extensions.regex_scripts = character.extensions.regex_scripts.map(normalize);
    const frame = {
        context, characterId, books: {}, settings: session.settings.world_info_settings,
        extensionSettings, diagnostics: [], loops: 0, tagMap: session.settings.tag_map ?? {},
        ...nativeRegexPreset(session.settings),
        diagnosticLabel: 'Regex evaluator reported an invalid expression or setting.',
    };
    frame.presetRegex = frame.presetRegex.map(normalize);
    return {
        apply(text, placement, options = {}) {
            configure(frame, getRegexedString);
            return context.run(() => getRegexedString(String(text ?? ''), placement, options));
        },
        warnings: frame.diagnostics,
    };
}
/** Apply the upstream global-regex placement migration without mutating stored settings. */
export function migrateGlobalRegex(script) {
    if (!script || typeof script !== 'object') return script;
    const migrated = { ...script, placement: Array.isArray(script.placement) ? [...script.placement] : [] };
    if (migrated.placement.includes(0)) {
        migrated.placement = migrated.placement.length === 1 ? [1, 2, 3, 5, 6] : migrated.placement.filter(value => value !== 0);
        migrated.markdownOnly = true;
        migrated.promptOnly = true;
    }
    if (migrated.placement.includes(4)) {
        migrated.placement = migrated.placement.length === 1 ? [3] : migrated.placement.filter(value => value !== 4);
    }
    return migrated;
}
function normalize(script) {
    if (!script || typeof script !== 'object') return {};
    return { ...script, placement: Array.isArray(script.placement) ? script.placement.map(Number) : [Number(script.placement ?? 1)], replaceString: String(script.replaceString ?? ''), trimStrings: script.trimStrings ?? [], substituteRegex: script.substituteRegex ?? 0 };
}
export const messagePlacement = message => message.is_user ? regex_placement.USER_INPUT : message.extra?.type === 'narrator' ? regex_placement.SLASH_COMMAND : regex_placement.AI_OUTPUT;
