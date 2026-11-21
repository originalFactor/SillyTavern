import crypto from 'node:crypto';
import { ApiError, requireObject, requireSafeId } from './contract.js';
import { editableSettings } from './macro-management.js';
import { migrateGlobalRegex } from './regex-runtime.js';
import { writeSettings } from './session.js';

function strings(value, label, maxBytes = 240) {
    if (!Array.isArray(value) || value.length > 512 || value.some(item => typeof item !== 'string' || !item.trim() || Buffer.byteLength(item) > maxBytes) || new Set(value).size !== value.length) throw new ApiError(400, 'validation', `${label} must contain at most 512 unique names.`);
}
function validate(document) {
    requireObject(document, 'Regex settings');
    if (Object.keys(document).some(key => !['enabled', 'scripts', 'characterAllowed', 'presetAllowed'].includes(key))) throw new ApiError(400, 'validation', 'Unknown regex settings field.');
    if (typeof document.enabled !== 'boolean' || !Array.isArray(document.scripts) || document.scripts.length > 512 || Buffer.byteLength(JSON.stringify(document)) > 1_048_576) throw new ApiError(400, 'validation', 'Regex settings need enabled, at most 512 scripts, and a 1 MiB JSON limit.');
    for (const script of document.scripts) {
        requireObject(script, 'Regex script');
        if (typeof script.findRegex !== 'string' || typeof script.replaceString !== 'string' || !Array.isArray(script.placement) || script.placement.some(value => ![0, 1, 2, 3, 5, 6].includes(value))) throw new ApiError(400, 'validation', 'Regex scripts require string findRegex/replaceString and a placement array.');
        if (script.trimStrings !== undefined && (!Array.isArray(script.trimStrings) || script.trimStrings.some(value => typeof value !== 'string'))) throw new ApiError(400, 'validation', 'Regex trimStrings must be a string array.');
        for (const key of ['disabled', 'markdownOnly', 'promptOnly', 'runOnEdit']) if (key in script && typeof script[key] !== 'boolean') throw new ApiError(400, 'validation', `${key} must be boolean.`);
        for (const key of ['minDepth', 'maxDepth']) if (script[key] != null && (!Number.isInteger(script[key]) || script[key] < -1 || script[key] > 10000)) throw new ApiError(400, 'validation', 'Regex depth limits must be null or integers in -1..10000.');
        if (script.substituteRegex !== undefined && ![0, 1, 2].includes(script.substituteRegex)) throw new ApiError(400, 'validation', 'Regex macro substitution must be 0, 1 or 2.');
    }
    strings(document.characterAllowed, 'Character regex scopes', 244);
    document.characterAllowed.forEach(value => requireSafeId(value.endsWith('.png') ? value.slice(0, -4) : value, 'Character avatar'));
    requireObject(document.presetAllowed, 'Preset regex scopes');
    if (Object.keys(document.presetAllowed).length > 32) throw new ApiError(400, 'validation', 'Too many preset API scope lists.');
    Object.values(document.presetAllowed).forEach(value => strings(value, 'Preset regex scopes'));
    return document;
}
function state(settings) {
    const ext = settings.extension_settings ?? {};
    if (ext.disabledExtensions != null && !Array.isArray(ext.disabledExtensions)) throw new ApiError(422, 'storage', 'Stored disabled extension list is malformed.');
    if (!Array.isArray(ext.regex ?? []) || !Array.isArray(ext.character_allowed_regex ?? [])) throw new ApiError(422, 'storage', 'Stored regex scripts or permissions are malformed.');
    const preset = ext.preset_allowed_regex ?? {};
    if (typeof preset !== 'object' || Array.isArray(preset) || Object.values(preset).some(value => !Array.isArray(value))) throw new ApiError(422, 'storage', 'Stored preset regex permissions are malformed.');
    const document = { enabled: !ext.disabledExtensions?.includes('regex'), scripts: ext.regex ?? [], characterAllowed: ext.character_allowed_regex ?? [], presetAllowed: ext.preset_allowed_regex ?? {} };
    if (Buffer.byteLength(JSON.stringify(document)) > 1_048_576) throw new ApiError(422, 'storage', 'Stored regex settings exceed the 1 MiB native editor bound. Nothing has been truncated.');
    const revision = crypto.createHash('sha256').update(JSON.stringify(document)).digest('hex');
    return { revision, settings: { ...document, scripts: document.scripts.map(migrateGlobalRegex) } };
}
export const getRegexSettings = session => state(editableSettings(session));
export function saveRegexSettings(session, body) {
    requireObject(body, 'Regex settings edit');
    if (Object.keys(body).some(key => !['expectedRevision', 'settings', 'confirmScopeChanges'].includes(key))) throw new ApiError(400, 'validation', 'Unknown regex settings edit field.');
    if (body.confirmScopeChanges !== undefined && typeof body.confirmScopeChanges !== 'boolean') throw new ApiError(400, 'validation', 'confirmScopeChanges must be boolean.');
    const settings = editableSettings(session), before = state(settings);
    if (body.expectedRevision !== before.revision) throw new ApiError(409, 'conflict', 'Regex scripts or permissions changed. Reload before saving; your draft has not been applied.');
    const next = validate(body.settings), current = before.settings;
    const added = next.characterAllowed.some(value => !current.characterAllowed.includes(value)) || Object.entries(next.presetAllowed).some(([api, values]) => values.some(value => !(Object.hasOwn(current.presetAllowed, api) ? current.presetAllowed[api] : []).includes(value)));
    const reenabling = next.enabled && !current.enabled && (next.characterAllowed.length || Object.values(next.presetAllowed).some(values => values.length));
    if ((added || reenabling) && body.confirmScopeChanges !== true) throw new ApiError(409, 'confirmation_required', 'Explicitly authorize the listed character/preset scopes before enabling their regex scripts. Imported cards and presets never grant this permission.');
    const ext = settings.extension_settings ??= {};
    ext.regex = next.scripts;
    ext.character_allowed_regex = next.characterAllowed;
    ext.preset_allowed_regex = next.presetAllowed;
    ext.disabledExtensions = [...(ext.disabledExtensions ?? []).filter(value => value !== 'regex'), ...(next.enabled ? [] : ['regex'])];
    writeSettings(session.directories, settings);
    return state(settings);
}
