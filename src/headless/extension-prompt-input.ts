import { ApiError } from './contract.js';

/** Data-only, per-request injections. Browser predicates never cross this boundary. */
export function validateExtensionPromptInput(value: any) {
    if (value === undefined) return undefined;
    const invalid = () => new ApiError(400, 'validation', 'Invalid or oversized extensionPrompts.');
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 128 || Buffer.byteLength(JSON.stringify(value)) > 1_048_576) throw invalid();
    const result: Record<string, any> = Object.create(null);
    for (const [key, entry] of Object.entries<any>(value)) {
        if (!key || key.length > 128 || /[\x00-\x1f\x7f]/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw invalid();
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(field => !['value', 'position', 'depth', 'scan', 'role'].includes(field))) throw invalid();
        if (typeof entry.value !== 'string' || entry.value.length > 65_536 || ![-1, 0, 1, 2].includes(entry.position) || !Number.isInteger(entry.depth) || entry.depth < 0 || entry.depth > 10000 || typeof entry.scan !== 'boolean' || ![0, 1, 2].includes(entry.role)) throw invalid();
        result[key] = { value: entry.value, position: entry.position, depth: entry.depth, scan: entry.scan, role: entry.role };
    }
    return result;
}
