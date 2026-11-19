/**
 * @readonly
 * @enum {number} Regex script placement
 */
export const regex_placement = Object.freeze({
    MD_DISPLAY: 0,
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    WORLD_INFO: 5,
    REASONING: 6,
});

/**
 * Compiles a ST regex script representation.
 * @param {unknown} regexString Regex source
 * @param {string} flags Fallback flags
 * @returns {RegExp} Compiled regex
 */
export function regexFromString(regexString, flags = 'g') {
    const match = /^\/(.+)\/([dgimsuvy]*)$/.exec(String(regexString));
    if (match) {
        return new RegExp(match[1], match[2] || flags);
    }
    return new RegExp(String(regexString), flags);
}

/**
 * Applies enabled global regex scripts without browser globals.
 * @param {string} text Input text
 * @param {Record<string, any>} extensionSettings Extension settings
 * @param {number} placement Regex placement
 * @returns {string} Processed text
 */
export function applyGlobalRegex(text, extensionSettings, placement) {
    const scripts = Array.isArray(extensionSettings?.regex) ? extensionSettings.regex : [];
    let result = String(text ?? '');
    for (const script of scripts) {
        if (!script || script.disabled || !script.findRegex) {
            continue;
        }
        const scriptPlacements = Array.isArray(script.placement)
            ? script.placement.map(Number)
            : [Number(script.placement ?? regex_placement.USER_INPUT)];
        if (!scriptPlacements.includes(placement)) {
            continue;
        }
        try {
            const find = regexFromString(script.findRegex, 'g');
            const replacement = String(script.replaceString ?? '');
            result = result.replace(find, replacement);
        } catch (error) {
            console.warn('[api-v1] Ignoring invalid regex script:', error instanceof Error ? error.message : error);
        }
    }
    return result;
}
