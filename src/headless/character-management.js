import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { ApiError, requireSafeId } from './contract.js';
import { assertCharacterIdle } from './generation-store.js';
import { normalizeCharacterData, readCharacter } from './session.js';
import { serverDirectory } from '../server-directory.js';
import { isPathUnderParent } from '../util.js';
import { parseCharX, buildCharX, stripCardMetadata } from './charx.js';

const MAX_CARD_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_CHARX_BYTES = 7 * 1024 * 1024;
const DEFAULT_IMAGE = path.join(serverDirectory, 'default', 'content', 'default_Seraphina.png');

/**
 * Validates an opaque card without discarding version-specific or extension data.
 * @param {unknown} card Card
 * @returns {Record<string, any>} Validated card
 */
function validateCard(card) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) throw new ApiError(400, 'validation', 'A character card object is required.');
    if (Buffer.byteLength(JSON.stringify(card)) > MAX_CARD_BYTES) throw new ApiError(413, 'validation', 'Character card exceeds 1 MiB.');
    if (card.spec !== undefined && !['chara_card_v2', 'chara_card_v3'].includes(card.spec)) throw new ApiError(422, 'unsupported', 'Only V1/V2/V3 character cards are supported.');
    if (card.spec && (!card.data || typeof card.data !== 'object' || Array.isArray(card.data))) throw new ApiError(422, 'validation', 'Versioned cards require a data object.');
    const data = card.data ?? card;
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 200) throw new ApiError(400, 'validation', 'Character name must contain 1–200 characters.');
    for (const key of ['description', 'personality', 'scenario', 'first_mes', 'mes_example']) {
        if (data[key] !== undefined && typeof data[key] !== 'string') throw new ApiError(400, 'validation', `Character ${key} must be text.`);
    }
    return card;
}

/**
 * Validates bounded canonical base64; Buffer.from alone silently ignores invalid input.
 * @param {unknown} value Base64
 * @param {number} limit Decoded limit
 * @returns {Buffer} Bytes
 */
function decode(value, limit) {
    if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
        throw new ApiError(400, 'validation', 'Invalid or oversized base64 file.');
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) throw new ApiError(400, 'validation', 'Invalid base64 encoding.');
    if (!bytes.length || bytes.length > limit) throw new ApiError(413, 'validation', 'Imported file exceeds its size limit.');
    return bytes;
}

function charxDirectory(session, characterId) {
    const id = requireSafeId(characterId, 'characterId');
    const root = path.resolve(session.directories.userImages);
    const directory = path.resolve(root, 'charx', id);
    if (!isPathUnderParent(root, directory)) throw new ApiError(400, 'validation', 'Invalid CHARX asset directory.');
    return directory;
}

/** Persist only normalized, bounded CHARX image bytes under the character's owned asset directory. */
function saveCharXAssets(session, characterId, assets) {
    const directory = charxDirectory(session, characterId);
    const auxiliary = assets.filter(asset => asset.type.toLowerCase() !== 'icon' && asset.type.toLowerCase() !== 'user_icon');
    if (!auxiliary.length) return;
    fs.mkdirSync(directory, { recursive: true });
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) {
        throw new ApiError(400, 'validation', 'Invalid CHARX asset directory.');
    }
    const manifest = auxiliary.map(asset => ({
        path: path.posix.basename(asset.path), type: asset.type, name: asset.name, extension: asset.extension,
    }));
    manifest.forEach(item => {
        if (!/^\d{3}\.[a-z0-9]+$/.test(item.path)) {
            throw new ApiError(422, 'validation', 'Invalid CHARX asset name.');
        }
    });
    for (const asset of auxiliary) {
        const target = path.resolve(directory, path.posix.basename(asset.path));
        if (!isPathUnderParent(directory, target)) throw new ApiError(422, 'validation', 'Invalid CHARX asset path.');
        writeFileAtomicSync(target, Buffer.from(asset.bytes));
    }
    writeFileAtomicSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
}

function loadCharXAssets(session, characterId) {
    const directory = charxDirectory(session, characterId);
    const manifestFile = path.join(directory, 'manifest.json');
    if (!fs.existsSync(manifestFile)) return [];
    if (fs.lstatSync(manifestFile).isSymbolicLink() || !fs.statSync(manifestFile).isFile()) {
        throw new ApiError(400, 'validation', 'Invalid CHARX asset manifest.');
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (!Array.isArray(manifest) || manifest.length > 64) throw new ApiError(400, 'validation', 'Invalid CHARX asset manifest.');
    let total = 0;
    return manifest.map(item => {
        const name = path.posix.basename(String(item?.path ?? ''));
        const target = path.resolve(directory, name);
        if (name !== item.path || !isPathUnderParent(directory, target) || !fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink()) {
            throw new ApiError(400, 'validation', 'Invalid CHARX asset manifest entry.');
        }
        const bytes = fs.readFileSync(target);
        total += bytes.length;
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || total > MAX_CHARX_BYTES) {
            throw new ApiError(413, 'validation', 'CHARX assets exceed 7 MiB.');
        }
        return {
            path: `assets/${name}`, bytes: Uint8Array.from(bytes), extension: String(item.extension ?? path.extname(name).slice(1)),
            type: String(item.type ?? ''), name: String(item.name ?? ''),
        };
    });
}

/**
 * Saves a new card or replaces the exact revision explicitly edited by the client.
 * @param {import('./session.js').HeadlessSession} session Session
 * @param {object} input Input
 * @param {string} input.characterId Stable identifier
 * @param {unknown} input.card Card object
 * @param {string} [input.expectedRevision] Previous file digest, required for replacement
 * @param {Buffer} [input.image] Imported PNG
 * @param {boolean} [input.create=true] Creation or revision-checked update
 * @returns {Promise<Record<string, any>>} Saved card document
 */
export async function saveCharacter(session, { characterId, card, expectedRevision, image, create = true }) {
    const id = requireSafeId(characterId, 'characterId');
    const validated = validateCard(card);
    const { write } = await import('../character-card-parser.js');
    const file = path.join(session.directories.characters, `${id}.png`);
    assertCharacterIdle(session.handle, id, session.directories);
    const exists = fs.existsSync(file);
    if (exists && (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile())) throw new ApiError(400, 'validation', 'Character path is not a regular file.');
    if (create && exists) throw new ApiError(409, 'conflict', 'Character ID already exists.');
    if (!create && !exists) throw new ApiError(404, 'not_found', 'Character not found.');
    const previous = exists ? fs.readFileSync(file) : null;
    if (!create && (!expectedRevision || crypto.createHash('sha256').update(previous).digest('hex') !== expectedRevision)) {
        throw new ApiError(409, 'conflict', 'Character changed since it was opened. Reload before saving.');
    }
    const avatar = image ?? previous ?? fs.readFileSync(DEFAULT_IMAGE);
    if (avatar.length > MAX_IMAGE_BYTES) throw new ApiError(413, 'validation', 'Character image exceeds 4 MiB.');
    let bytes;
    try { bytes = write(avatar, JSON.stringify(validated), { preserveSpec: true }); } catch { throw new ApiError(422, 'validation', 'Invalid PNG character image.'); }
    if (bytes.length > MAX_IMAGE_BYTES) throw new ApiError(413, 'validation', 'Character image including metadata exceeds 4 MiB.');
    fs.mkdirSync(session.directories.characters, { recursive: true });
    writeFileAtomicSync(file, bytes);
    const data = normalizeCharacterData(validated);
    return { id, avatar: `${id}.png`, name: data.name, data, raw: validated, revision: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/** Replace a character image while retaining the inspected card and revision fence. */
export async function replaceCharacterAvatar(session, characterId, expectedRevision, dataBase64) {
    const image = decode(dataBase64, MAX_IMAGE_BYTES);
    const character = await readCharacter(session, characterId);
    return saveCharacter(session, { characterId, card: character.raw, expectedRevision, image, create: false });
}

/**
 * Imports JSON or a PNG/APNG carrying character metadata. No scripts are executed.
 * @param {import('./session.js').HeadlessSession} session Session
 * @param {object} input Input
 * @param {string} input.characterId Stable caller-owned ID
 * @param {string} input.format json or png
 * @param {string} input.dataBase64 File data
 * @returns {Promise<Record<string, any>>} Imported card
 */
export async function importCharacter(session, { characterId, format, dataBase64 }) {
    if (!['json', 'png', 'charx'].includes(format)) throw new ApiError(422, 'unsupported', 'Import supports JSON, PNG/APNG and CHARX character cards.');
    const bytes = decode(dataBase64, format === 'json' ? MAX_CARD_BYTES : format === 'charx' ? MAX_CHARX_BYTES : MAX_IMAGE_BYTES);
    let card;
    let image;
    let charxAssets = [];
    if (format === 'charx') {
        const parsed = await parseCharX(bytes);
        card = parsed.card;
        image = parsed.icon;
        charxAssets = parsed.assets;
    } else {
        try {
            if (format === 'png') {
                const { read } = await import('../character-card-parser.js');
                card = JSON.parse(read(bytes));
                image = bytes;
            } else card = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
        } catch { throw new ApiError(422, 'validation', 'File does not contain a valid character card.'); }
    }
    const saved = await saveCharacter(session, { characterId, card, image });
    saveCharXAssets(session, saved.id, charxAssets);
    return saved;
}

/**
 * Exports the current card in a credential-free envelope consumable by native file pickers.
 * @param {import('./session.js').HeadlessSession} session Session
 * @param {string} characterId ID
 * @param {string} format json or png
 * @returns {Promise<{fileName:string,mimeType:string,dataBase64:string}>} File envelope
 */
export async function exportCharacter(session, characterId, format) {
    const card = await readCharacter(session, characterId);
    if (!['json', 'png', 'charx'].includes(format)) throw new ApiError(422, 'unsupported', 'Export format must be json, png or charx.');
    const png = fs.readFileSync(path.join(session.directories.characters, card.avatar));
    const bytes = whenFormat(format, {
        json: () => Buffer.from(JSON.stringify(card.raw, null, 2)),
        png: () => png,
        charx: () => buildCharX(card.raw, stripCardMetadata(png), loadCharXAssets(session, card.id)),
    });
    const mimeType = format === 'json' ? 'application/json' : format === 'png' ? 'image/png' : 'application/zip';
    return { fileName: `${card.id}.${format}`, mimeType, dataBase64: bytes.toString('base64') };
}

function whenFormat(format, actions) {
    const action = actions[format];
    if (!action) throw new ApiError(422, 'unsupported', 'Unsupported character card format.');
    return action();
}

/**
 * Deletes a revision-checked character. Chat deletion requires a separate explicit flag.
 * @param {import('./session.js').HeadlessSession} session Session
 * @param {string} characterId ID
 * @param {string} expectedRevision Current file digest
 * @param {boolean} deleteChats Explicit destructive authorization
 * @returns {void}
 */
export function deleteCharacter(session, characterId, expectedRevision, deleteChats) {
    const id = requireSafeId(characterId, 'characterId');
    assertCharacterIdle(session.handle, id, session.directories);
    const file = path.join(session.directories.characters, `${id}.png`);
    if (!fs.existsSync(file)) throw new ApiError(404, 'not_found', 'Character not found.');
    if (fs.lstatSync(file).isSymbolicLink()) throw new ApiError(400, 'validation', 'Character path is not a regular file.');
    if (!expectedRevision || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expectedRevision) throw new ApiError(409, 'conflict', 'Character changed. Refresh before deleting.');
    const chats = path.join(session.directories.chats, id);
    if (fs.existsSync(chats) && fs.readdirSync(chats).length) {
        if (!deleteChats) throw new ApiError(409, 'conflict', 'Character has chats. Explicit chat deletion is required.');
        fs.rmSync(chats, { recursive: true });
    }
    fs.unlinkSync(file);
}
