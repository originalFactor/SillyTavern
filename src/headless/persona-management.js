import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, requireSafeId } from './contract.js';
import { readSettings, writeSettings } from './session.js';
import { serverDirectory } from '../server-directory.js';
import { getWorldBook } from './world-info-management.js';

/**
 * Derives a revision only from persona-owned state, not provider settings.
 * @param {Record<string, any>} settings Settings
 * @returns {string} Revision
 */
function revision(settings) {
    const p = settings.power_user ?? {};
    return crypto.createHash('sha256').update(JSON.stringify({
        names: p.personas ?? {}, descriptions: p.persona_descriptions ?? {},
        avatar: settings.user_avatar ?? '', username: settings.username,
        description: p.persona_description, position: p.persona_description_position,
        depth: p.persona_description_depth, role: p.persona_description_role,
        lorebook: p.persona_description_lorebook, defaultPersona: p.default_persona,
    })).digest('hex');
}

/**
 * Lists standard SillyTavern persona settings without returning unrelated settings.
 * @param {import('./session.js').HeadlessSession} session Session
 * @returns {Record<string, any>} Persona catalog
 */
export function listPersonas(session) {
    return catalog(readSettings(session.directories));
}

/**
 * @param {Record<string, any>} settings Settings
 * @returns {Record<string, any>} Catalog
 */
function catalog(settings) {
    const p = settings.power_user ?? {};
    const selectedId = String(settings.user_avatar ?? '');
    return {
        revision: revision(settings), selectedId,
        personas: Object.entries(p.personas ?? {}).map(([id, name]) => {
            const d = p.persona_descriptions?.[id] ?? {};
            return { id, name: String(name), description: String(d.description ?? ''), title: String(d.title ?? ''),
                position: Number(d.position ?? 0) === 1 ? 0 : Number(d.position ?? 0), depth: Number(d.depth ?? 2), role: Number(d.role ?? 0), lorebook: String(d.lorebook ?? '') };
        }),
    };
}

/**
 * Reads current settings and rejects stale persona writes, preserving other settings.
 * @param {import('./session.js').HeadlessSession} session Session
 * @param {string} expectedRevision Revision
 * @returns {Record<string, any>} Settings
 */
function editable(session, expectedRevision) {
    const settings = readSettings(session.directories);
    if (!expectedRevision || revision(settings) !== expectedRevision) throw new ApiError(409, 'conflict', 'Personas changed. Reload before saving.');
    settings.power_user ??= {};
    settings.power_user.personas = { ...settings.power_user.personas };
    settings.power_user.persona_descriptions = { ...settings.power_user.persona_descriptions };
    return settings;
}

/**
 * Activates a persona using the same settings fields as the browser client.
 * @param {Record<string, any>} settings Settings
 * @param {string} id ID
 * @returns {void}
 */
function activate(settings, id) {
    const p = settings.power_user;
    if (!Object.hasOwn(p.personas, id)) throw new ApiError(404, 'not_found', 'Persona not found.');
    const d = p.persona_descriptions[id] ?? {};
    const position = Number(d.position ?? 0) === 1 ? 0 : Number(d.position ?? 0);
    if (![0, 2, 3, 4, 9].includes(position)) throw new ApiError(422, 'unsupported', 'This persona uses an unknown placement.');
    settings.user_avatar = id;
    settings.username = p.personas[id];
    p.persona_description = String(d.description ?? '');
    p.persona_description_position = position;
    p.persona_description_depth = Number(d.depth ?? 2);
    p.persona_description_role = Number(d.role ?? 0);
    p.persona_description_lorebook = String(d.lorebook ?? '');
}

/**
 * Saves name/description/placement without dropping unknown descriptor properties.
 * @param {import('./session.js').HeadlessSession} session Session
 * @param {string} personaId Persona avatar filename
 * @param {Record<string, any>} input Input including expectedRevision
 * @returns {Record<string, any>} Updated catalog
 */
export function savePersona(session, personaId, input) {
    const id = requireSafeId(personaId, 'personaId');
    const settings = editable(session, input.expectedRevision);
    const p = settings.power_user;
    if (!Object.hasOwn(p.personas, id) && !id.endsWith('.png')) throw new ApiError(400, 'validation', 'New persona identifiers must end in .png.');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw new ApiError(400, 'validation', 'Persona name must contain 1–200 characters.');
    if (typeof input.description !== 'string' || input.description.length > 65536) throw new ApiError(400, 'validation', 'Persona description must contain at most 65536 characters.');
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 200)) throw new ApiError(400, 'validation', 'Persona title is too long.');
    const previous = p.persona_descriptions[id] ?? {};
    if (input.lorebook !== undefined) {
        if (typeof input.lorebook !== 'string') throw new ApiError(400, 'validation', 'Persona lorebook must be a string; empty clears its binding.');
        if (input.lorebook && input.lorebook !== previous.lorebook) getWorldBook(session, input.lorebook);
    }
    const requestedPosition = input.position ?? previous.position ?? 0;
    const position = requestedPosition === 1 ? 0 : requestedPosition;
    const depth = input.depth ?? previous.depth ?? 2;
    const role = input.role ?? previous.role ?? 0;
    if (![0, 2, 3, 4, 9].includes(position) || !Number.isInteger(depth) || depth < 0 || depth > 100 || ![0, 1, 2].includes(role)) throw new ApiError(422, 'unsupported', 'Persona placement, role or depth is invalid.');
    p.personas[id] = input.name.trim();
    p.persona_descriptions[id] = { ...previous, description: input.description, title: input.title ?? previous.title ?? '', position, depth, role, ...(input.lorebook === undefined ? {} : { lorebook: input.lorebook }) };
    if (Object.keys(p.personas).length > 128 || Buffer.byteLength(JSON.stringify(p.persona_descriptions)) > 4 * 1024 * 1024) throw new ApiError(413, 'validation', 'Persona catalog exceeds its size limit.');
    if (input.select === true || settings.user_avatar === id) activate(settings, id);
    const avatar = path.join(session.directories.avatars, id);
    const createAvatar = !fs.existsSync(avatar);
    if (createAvatar) {
        fs.mkdirSync(session.directories.avatars, { recursive: true });
        const packaged = path.join(serverDirectory, 'default/content/companion-user.png');
        const source = fs.existsSync(packaged) ? packaged : path.join(serverDirectory, 'public/img/user-default.png');
        fs.copyFileSync(source, avatar, fs.constants.COPYFILE_EXCL);
    }
    try { writeSettings(session.directories, settings); } catch (error) { if (createAvatar) fs.unlinkSync(avatar); throw error; }
    return catalog(settings);
}

/**
 * @param {import('./session.js').HeadlessSession} session Session
 * @param {string} personaId ID
 * @param {string} expectedRevision Revision
 * @returns {Record<string, any>} Catalog
 */
export function selectPersona(session, personaId, expectedRevision) {
    const id = requireSafeId(personaId, 'personaId');
    const settings = editable(session, expectedRevision);
    activate(settings, id);
    writeSettings(session.directories, settings);
    return catalog(settings);
}

/**
 * Removing a persona never removes messages; its historical name/text stays in JSONL.
 * @param {import('./session.js').HeadlessSession} session Session
 * @param {string} personaId ID
 * @param {string} expectedRevision Revision
 * @returns {Record<string, any>} Catalog
 */
export function deletePersona(session, personaId, expectedRevision) {
    const id = requireSafeId(personaId, 'personaId');
    const settings = editable(session, expectedRevision);
    const p = settings.power_user;
    if (!Object.hasOwn(p.personas, id)) throw new ApiError(404, 'not_found', 'Persona not found.');
    delete p.personas[id];
    delete p.persona_descriptions[id];
    if (p.default_persona === id) p.default_persona = null;
    if (settings.user_avatar === id) {
        settings.user_avatar = '';
        settings.username = 'User';
        p.persona_description = '';
        p.persona_description_lorebook = '';
        p.persona_description_position = 0;
        p.persona_description_depth = 2;
        p.persona_description_role = 0;
    }
    writeSettings(session.directories, settings);
    const avatar = path.join(session.directories.avatars, id);
    if (fs.existsSync(avatar) && !fs.lstatSync(avatar).isSymbolicLink()) fs.unlinkSync(avatar);
    return catalog(settings);
}
