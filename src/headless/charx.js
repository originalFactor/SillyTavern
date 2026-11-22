import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import yauzl from 'yauzl';
import encode from '../png/encode.js';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';
import { ApiError } from './contract.js';

const MAX_ARCHIVE_BYTES = 7 * 1024 * 1024;
const MAX_CARD_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_COUNT = 64;
const MAX_TOTAL_ASSET_BYTES = 6 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 256;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 7 * 1024 * 1024;
const EMBEDDED_PREFIXES = ['embeded://', 'embedded://', '__asset:'];
const IMAGE_EXTENSIONS = new Set(['png', 'apng', 'webp', 'jpg', 'jpeg', 'gif', 'avif', 'bmp', 'jfif']);

function normalizePath(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const normalized = path.posix.normalize(value.replaceAll('\\', '/').replace(/^\.\/+/, '').trim());
    if (!normalized || normalized === '.' || normalized.startsWith('..') || path.posix.isAbsolute(normalized)) return null;
    return normalized.replace(/^\//, '');
}

function embeddedPath(value) {
    if (typeof value !== 'string') return null;
    for (const prefix of EMBEDDED_PREFIXES) {
        if (value.toLowerCase().startsWith(prefix)) return normalizePath(value.slice(prefix.length));
    }
    return null;
}

function isEmbeddedUri(value) {
    return typeof value === 'string' && EMBEDDED_PREFIXES.some(prefix => value.toLowerCase().startsWith(prefix));
}

function assetExtension(asset, archivePath) {
    const declared = typeof asset?.ext === 'string' ? asset.ext.trim().toLowerCase().replace(/^\./, '') : '';
    return declared || path.posix.extname(archivePath).slice(1).toLowerCase();
}

function pngSignature(bytes) {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

/** Remove chara/ccv3 metadata so a CHARX icon contains image bytes only. */
export function stripCardMetadata(bytes) {
    if (!pngSignature(bytes)) throw new ApiError(422, 'validation', 'CharX icon must be a PNG.');
    const chunks = extract(new Uint8Array(bytes)).filter(chunk => {
        if (chunk.name !== 'tEXt') return true;
        const keyword = PNGtext.decode(chunk.data).keyword.toLowerCase();
        return keyword !== 'chara' && keyword !== 'ccv3';
    });
    return Buffer.from(encode(chunks));
}

function openArchive(bytes) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(bytes, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, archive) => {
            if (error) reject(new ApiError(422, 'validation', 'Invalid CharX ZIP archive.'));
            else resolve(archive);
        });
    });
}

function listEntries(archive) {
    return new Promise((resolve, reject) => {
        const entries = [];
        let totalUncompressed = 0;
        archive.readEntry();
        archive.on('entry', entry => {
            const normalized = normalizePath(entry.fileName);
            if (!normalized || normalized.startsWith('__MACOSX/') || entry.fileName.endsWith('/')) {
                archive.readEntry();
                return;
            }
            totalUncompressed += Number(entry.uncompressedSize) || 0;
            if (entries.length >= MAX_ARCHIVE_ENTRIES || totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
                reject(new ApiError(413, 'validation', 'CharX archive has too many entries or expands beyond 7 MiB.'));
                archive.close();
                return;
            }
            entries.push({ entry, path: normalized, size: Number(entry.uncompressedSize) || 0 });
            archive.readEntry();
        });
        archive.once('error', error => reject(new ApiError(422, 'validation', `Invalid CharX archive: ${error.message}`)));
        archive.once('end', () => resolve(entries));
    });
}

function readEntry(archive, item, limit) {
    if (item.size > limit) throw new ApiError(413, 'validation', 'CharX entry exceeds its size limit.');
    return new Promise((resolve, reject) => {
        let settled = false;
        archive.openReadStream(item.entry, (error, stream) => {
            if (error) {
                settled = true;
                reject(new ApiError(422, 'validation', 'CharX entry could not be read.'));
                return;
            }
            const chunks = [];
            let size = 0;
            stream.on('data', chunk => {
                if (settled) return;
                size += chunk.length;
                if (size > limit) {
                    settled = true;
                    stream.destroy();
                    reject(new ApiError(413, 'validation', 'CharX entry exceeds its size limit.'));
                    return;
                }
                chunks.push(chunk);
            });
            stream.on('error', failure => {
                if (settled) return;
                settled = true;
                reject(new ApiError(422, 'validation', `CharX entry could not be read: ${failure.message}`));
            });
            stream.on('end', () => {
                if (settled) return;
                settled = true;
                resolve(Buffer.concat(chunks));
            });
        });
    });
}

/** Bounded read of the CharX ZIP, preserving the card's opaque schema and declared assets. */
export async function parseCharX(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_ARCHIVE_BYTES) {
        throw new ApiError(413, 'validation', 'CharX archive exceeds 7 MiB.');
    }
    const archive = await openArchive(bytes);
    let entries;
    try {
        entries = await listEntries(archive);
    } catch (error) {
        archive.close();
        throw error;
    }
    const cardEntry = entries.find(item => item.path === 'card.json' || item.path.endsWith('/card.json'));
    if (!cardEntry) {
        archive.close();
        throw new ApiError(422, 'validation', 'CharX archive is missing card.json.');
    }
    let card;
    try {
        const cardBytes = await readEntry(archive, cardEntry, MAX_CARD_BYTES);
        if (!cardBytes.length) throw new Error('empty card');
        card = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(cardBytes).replace(/^\uFEFF/, ''));
    } catch (error) {
        archive.close();
        if (error instanceof ApiError) throw error;
        throw new ApiError(422, 'validation', 'CharX card.json is not valid UTF-8 JSON.');
    }
    if (!card || typeof card !== 'object' || Array.isArray(card) || card.spec === undefined) {
        archive.close();
        throw new ApiError(422, 'validation', 'CharX card.json is not a versioned character card.');
    }
    const declaredAssets = Array.isArray(card?.data?.assets) ? card.data.assets : [];
    if (declaredAssets.length > MAX_ASSET_COUNT) {
        archive.close();
        throw new ApiError(413, 'validation', 'CharX declares too many assets.');
    }
    try {
        const assets = [];
        let totalAssetBytes = 0;
        let icon = null;
        for (const [index, asset] of declaredAssets.entries()) {
            const archivePath = embeddedPath(asset?.uri);
            if (!archivePath) {
                if (isEmbeddedUri(asset?.uri)) throw new ApiError(422, 'validation', 'CharX asset path is invalid.');
                continue;
            }
            const item = entries.find(candidate => candidate.path === archivePath);
            if (!item) throw new ApiError(422, 'validation', 'CharX asset is missing from the archive.');
            const payload = await readEntry(archive, item, MAX_ASSET_BYTES);
            const extension = assetExtension(asset, archivePath);
            if (!IMAGE_EXTENSIONS.has(extension) || !payload.length) {
                throw new ApiError(422, 'validation', 'CharX asset has an unsupported image extension.');
            }
            totalAssetBytes += payload.length;
            if (totalAssetBytes > MAX_TOTAL_ASSET_BYTES) throw new ApiError(413, 'validation', 'CharX assets exceed 6 MiB.');
            const normalized = {
                path: `assets/${String(index).padStart(3, '0')}.${extension}`,
                bytes: Uint8Array.from(payload),
                extension,
                type: typeof asset?.type === 'string' ? asset.type : '',
                name: typeof asset?.name === 'string' ? asset.name : '',
            };
            assets.push(normalized);
            const type = typeof asset?.type === 'string' ? asset.type.toLowerCase() : '';
            if (type === 'icon' && !icon && (extension === 'png' || extension === 'apng')) icon = payload;
        }
        if (icon && !pngSignature(icon)) throw new ApiError(422, 'validation', 'CharX PNG icon is invalid.');
        return { card, icon, assets };
    } finally {
        archive.close();
    }
}

/** Canonical, credential-free CharX output containing card.json and its declared PNG icon/assets. */
export function buildCharX(rawCard, icon, assets = []) {
    if (!rawCard?.spec || !rawCard?.data || typeof rawCard.data !== 'object' || Array.isArray(rawCard.data)) {
        throw new ApiError(422, 'unsupported', 'CHARX export requires a versioned V2/V3 card with a data object.');
    }
    const declared = [{
        type: 'icon',
        name: 'main',
        ext: 'png',
        uri: 'embedded://assets/main.png',
    }];
    const files = {};
    for (const asset of assets) {
        const normalized = normalizePath(asset?.path);
        if (!normalized || !normalized.startsWith('assets/') || !asset?.bytes || asset.bytes.length > MAX_ASSET_BYTES) {
            throw new ApiError(422, 'validation', 'Invalid CharX auxiliary asset.');
        }
        declared.push({
            type: typeof asset.type === 'string' ? asset.type : 'misc',
            name: typeof asset.name === 'string' ? asset.name : '',
            ext: asset.extension || path.posix.extname(normalized).slice(1),
            uri: `embedded://${normalized}`,
        });
        files[normalized] = Uint8Array.from(asset.bytes);
    }
    const card = { ...rawCard, data: { ...rawCard.data, assets: declared } };
    const cardBytes = strToU8(JSON.stringify(card));
    if (cardBytes.length > MAX_CARD_BYTES) throw new ApiError(413, 'validation', 'Character card exceeds 1 MiB.');
    if (!Buffer.isBuffer(icon) || !pngSignature(icon) || icon.length > MAX_IMAGE_BYTES) {
        throw new ApiError(422, 'validation', 'CharX icon must be a PNG under 4 MiB.');
    }
    files['card.json'] = cardBytes;
    files['assets/main.png'] = Uint8Array.from(icon);
    const archive = zipSync(files, { level: 0 });
    if (archive.length > MAX_ARCHIVE_BYTES) throw new ApiError(413, 'validation', 'CharX archive exceeds 7 MiB.');
    return Buffer.from(archive);
}
