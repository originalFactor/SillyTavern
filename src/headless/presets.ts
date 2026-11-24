import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { ApiError } from './contract.js';
import { hasCredentialValues, isCredentialField, publicConfiguration } from './redaction.js';
import { activePromptOrder, validatePromptManager } from './prompt-manager.js';
import { PRESET_SETTING_KEYS, PRESET_CONNECTION_FIELDS } from './preset-mapping.js';
import { readSettings, writeSettings } from './session.js';
import { serverDirectory } from '../server-directory.js';

const KINDS: Record<string, any> = {
    'chat-completion': { directory: 'openAI_Settings', builtin: 'openai' },
    context: { directory: 'context', builtin: 'context' },
    instruct: { directory: 'instruct', builtin: 'instruct' },
    sysprompt: { directory: 'sysprompt', builtin: 'sysprompt' },
};
const MAX_PRESET_BYTES = 1_048_576;
const digest = (value: any) => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

function folders(session: any, kind: any) {
    const config = Object.hasOwn(KINDS, kind) ? KINDS[kind] : null;
    if (!config) throw new ApiError(400, 'validation', 'Unknown preset kind.');
    const user = session.directories[config.directory];
    if (!user) throw new ApiError(500, 'internal', 'Preset storage is unavailable.');
    if (fs.existsSync(user) && fs.lstatSync(user).isSymbolicLink()) throw new ApiError(400, 'validation', 'Preset directory must not be a symbolic link.');
    return { user, builtin: path.join(serverDirectory, 'default/content/presets', config.builtin) };
}

function validName(name: any) {
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || Buffer.byteLength(name) > 200 || /[\\/:*?"<>|\x00-\x1f]/.test(name) || name.includes('..') || name.endsWith('.')) throw new ApiError(400, 'validation', 'Preset name is invalid.');
    return name;
}

function readFile(directory: any, name: any) {
    const file = path.join(directory, `${validName(name)}.json`);
    if (!fs.existsSync(file)) return null;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_PRESET_BYTES) throw new ApiError(400, 'validation', 'Preset must be a regular JSON file of at most 1 MiB.');
    const bytes = fs.readFileSync(file);
    let preset;
    try { preset = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new ApiError(400, 'validation', 'Preset is not valid JSON.'); }
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) throw new ApiError(400, 'validation', 'Preset must be a JSON object.');
    return { preset, revision: digest(bytes), file };
}

function resolvePreset(session: any, kind: any, name: any) {
    const dirs = folders(session, kind);
    const owned = readFile(dirs.user, name);
    const found = owned ?? readFile(dirs.builtin, name);
    if (!found) throw new ApiError(404, 'not_found', 'Preset not found.');
    return { ...found, name, kind, origin: owned ? 'user' : 'builtin' };
}

function current(settings: any, kind: any) {
    if (kind === 'chat-completion') return { main_api: settings.main_api, settings: publicConfiguration(settings.oai_settings ?? {}) };
    return { settings: publicConfiguration(settings.power_user?.[kind] ?? {}) };
}
const activeRevision = (settings: any, kind: any) => digest(JSON.stringify(current(settings, kind)));
const selectedName = (settings: any, kind: any) => String(kind === 'chat-completion' ? settings.oai_settings?.preset_settings_openai ?? '' : (kind === 'instruct' ? settings.power_user?.instruct?.preset : settings.power_user?.[kind]?.name) ?? '');

export function listPresets(session: any, kind: any) {
    const dirs = folders(session, kind);
    const names = new Set<string>();
    for (const dir of [dirs.builtin, dirs.user]) {
        if (fs.existsSync(dir)) for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.json')) names.add(entry.name.slice(0, -5));
    }
    const presets = [], warnings = [];
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
        try { const found = resolvePreset(session, kind, name); presets.push({ name, revision: found.revision, origin: found.origin }); } catch (error) { warnings.push({ name, message: error instanceof ApiError ? error.message : 'Unreadable preset.' }); }
    }
    const settings = readSettings(session.directories);
    return { kind, activeName: selectedName(settings, kind), activeRevision: activeRevision(settings, kind), presets, warnings };
}

function connectionChanges(settings: any, preset: any) {
    return [...PRESET_CONNECTION_FIELDS].filter(key => Object.hasOwn(preset, key) && !equal(preset[key], settings.oai_settings?.[(PRESET_SETTING_KEYS as Record<string, string>)[key]]));
}

export function getPreset(session: any, kind: any, name: any) {
    const found = resolvePreset(session, kind, name);
    const preset = publicConfiguration(found.preset);
    const settings = readSettings(session.directories);
    const changes = kind === 'chat-completion' ? connectionChanges(settings, removeCredentials(preset)) : [];
    const knownPromptIds = new Set(Array.isArray(preset.prompts) ? preset.prompts.map((prompt: any) => prompt?.identifier).filter((id: any) => typeof id === 'string') : []);
    const order = kind === 'chat-completion' ? activePromptOrder(preset)?.order ?? [] : [];
    const compatibilityWarnings = order.filter((entry: any) => entry && typeof entry.identifier === 'string' && !knownPromptIds.has(entry.identifier))
        .map((entry: any) => ({ code: 'unresolved_prompt_order', identifier: entry.identifier, enabled: entry.enabled === true }));
    return { kind, name, revision: found.revision, origin: found.origin, preset, credentialsRedacted: !equal(preset, found.preset), connectionChanges: changes, connectionSettings: Object.fromEntries(changes.map(key => [key, preset[key]])), compatibilityWarnings };
}

export function activePreset(session: any, kind: any) {
    folders(session, kind);
    const settings = readSettings(session.directories);
    const source = kind === 'chat-completion' ? settings.oai_settings ?? {} : settings.power_user?.[kind] ?? {};
    const preset = kind === 'chat-completion'
        ? Object.fromEntries(Object.entries(PRESET_SETTING_KEYS).filter(([, key]) => Object.hasOwn(source, key)).map(([key, setting]) => [key, source[setting]])) : structuredClone(source);
    // Credentials are configured only through their dedicated settings/secret
    // surfaces, never embedded in portable preset snapshots.
    const clean = removeCredentials(preset);
    return { kind, name: selectedName(settings, kind), preset: clean, revision: activeRevision(settings, kind) };
}

/** Set the text-completion Instruct switch against the inspected active settings. */
export function setInstructEnabled(session: any, body: any) {
    if (typeof body?.enabled !== 'boolean') throw new ApiError(400, 'validation', 'Instruct enabled must be a boolean.');
    const settings = readSettings(session.directories);
    if (body.expectedRevision !== activeRevision(settings, 'instruct')) throw new ApiError(409, 'conflict', 'Instruct settings changed. Reload before saving.');
    settings.power_user ??= {};
    settings.power_user.instruct = { ...(settings.power_user.instruct ?? {}), enabled: body.enabled };
    writeSettings(session.directories, settings);
    return activePreset(session, 'instruct');
}

function removeCredentials(value: any): any {
    if (Array.isArray(value)) return value.map(removeCredentials);
    if (!value || typeof value !== 'object') return publicConfiguration(value);
    return Object.fromEntries(Object.entries(value).filter(([key]) => !isCredentialField(key)).map(([key, item]): any  => [key, removeCredentials(item)]));
}

function validatePreset(kind: any, preset: any) {
    if (!preset || typeof preset !== 'object' || Array.isArray(preset) || Buffer.byteLength(JSON.stringify(preset)) > MAX_PRESET_BYTES) throw new ApiError(400, 'validation', 'Preset must be a JSON object of at most 1 MiB.');
    if (hasCredentialValues(preset)) throw new ApiError(400, 'validation', 'Remove credential fields and custom headers before importing a preset. Configure credentials separately.');
    if (kind === 'chat-completion' && (preset.prompts !== undefined || preset.prompt_order !== undefined)) {
        const order = activePromptOrder(preset)?.order;
        if (!Array.isArray(preset.prompts) || !Array.isArray(order)) throw new ApiError(400, 'validation', 'Chat Completion prompts need a global prompt order.');
        const promptIds = new Set(preset.prompts.map((prompt: any) => prompt?.identifier).filter((id: any) => typeof id === 'string'));
        // Upstream preset orders can retain identifiers whose prompt content
        // was deliberately removed. Keep those entries in the portable file,
        // but validate and run only entries with actual prompt definitions.
        for (const entry of order) {
            if (!entry || typeof entry !== 'object' || typeof entry.identifier !== 'string' || typeof entry.enabled !== 'boolean') {
                throw new ApiError(400, 'validation', 'Prompt order entries must have a string identifier and enabled boolean.');
            }
        }
        validatePromptManager({ prompts: preset.prompts, order: order.filter(entry => promptIds.has(entry.identifier)) });
    }
    for (const key of ['temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k', 'min_p', 'openai_max_context', 'openai_max_tokens']) {
        if (Object.hasOwn(preset, key) && (typeof preset[key] !== 'number' || !Number.isFinite(preset[key]))) throw new ApiError(400, 'validation', `${key} must be a finite number.`);
    }
}

export function savePreset(session: any, kind: any, name: any, body: any) {
    const dirs = folders(session, kind);
    validName(name);
    validatePreset(kind, body?.preset);
    let existing = null;
    try { existing = resolvePreset(session, kind, name); } catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
    if (existing ? body.expectedRevision !== existing.revision : body.expectedRevision !== undefined) throw new ApiError(409, 'conflict', 'Preset changed or already exists. Inspect its revision before saving.');
    fs.mkdirSync(dirs.user, { recursive: true });
    writeFileAtomicSync(path.join(dirs.user, `${name}.json`), JSON.stringify(body.preset, null, 4), 'utf8');
    return getPreset(session, kind, name);
}

export function deletePreset(session: any, kind: any, name: any, expectedRevision: any) {
    const found = resolvePreset(session, kind, name);
    if (found.revision !== expectedRevision) throw new ApiError(409, 'conflict', 'Preset changed. Reload before deleting.');
    if (found.origin !== 'user') throw new ApiError(409, 'conflict', 'Built-in presets cannot be deleted.');
    if (selectedName(readSettings(session.directories), kind) === name) throw new ApiError(409, 'conflict', 'Select a different preset before deleting the active preset.');
    fs.unlinkSync(found.file);
    return { deleted: true, name };
}

export function activatePreset(session: any, kind: any, name: any, body: any) {
    const found = resolvePreset(session, kind, name);
    const settings = readSettings(session.directories);
    if (body?.expectedRevision !== found.revision || body?.expectedActiveRevision !== activeRevision(settings, kind)) throw new ApiError(409, 'conflict', 'Preset or active configuration changed. Reload before selecting.');
    const preset = removeCredentials(found.preset);
    validatePreset(kind, preset);
    if (kind === 'chat-completion') {
        const source = preset.chat_completion_source ?? settings.oai_settings?.chat_completion_source;
        if (!['openai', 'custom'].includes(source)) throw new ApiError(422, 'unsupported', `Provider source ${String(source)} is not available in the native companion.`);
        if (connectionChanges(settings, preset).length && body.allowConnectionChanges !== true) throw new ApiError(409, 'confirmation_required', 'This preset changes provider/model/connection settings. Explicit confirmation is required.');
        const oai = settings.oai_settings ??= {};
        for (const [key, value] of Object.entries(preset)) if (Object.hasOwn(PRESET_SETTING_KEYS, key)) oai[(PRESET_SETTING_KEYS as Record<string, string>)[key]] = value;
        for (const [legacyKey, identifier] of [['main_prompt', 'main'], ['nsfw_prompt', 'nsfw'], ['jailbreak_prompt', 'jailbreak']]) {
            if (typeof preset[legacyKey] !== 'string' || !preset[legacyKey]) continue;
            const prompts = structuredClone(Array.isArray(oai.prompts) ? oai.prompts : []);
            const prompt = prompts.find((item: any) => item.identifier === identifier);
            if (prompt) prompt.content = preset[legacyKey];
            else prompts.push({ identifier, content: preset[legacyKey], system_prompt: true, role: 'system' });
            oai.prompts = prompts;
        }
        oai.preset_settings_openai = name;
        settings.main_api = 'openai';
    } else {
        settings.power_user ??= {};
        // Selecting context/system/instruct templates does not enable a mode.
        // Enabling text completion still needs a supported provider/runtime.
        const enabled = settings.power_user[kind]?.enabled;
        settings.power_user[kind] = { ...(settings.power_user[kind] ?? {}), ...preset, name, ...(kind === 'instruct' ? { preset: name } : {}) };
        if (kind === 'instruct') settings.power_user[kind].enabled = enabled === true;
    }
    writeSettings(session.directories, settings);
    return listPresets(session, kind);
}

export function exportPreset(session: any, kind: any, name: any) {
    const document = getPreset(session, kind, name);
    return { fileName: `${name}.json`, mimeType: 'application/json', dataBase64: Buffer.from(JSON.stringify(removeCredentials(document.preset), null, 4)).toString('base64') };
}
