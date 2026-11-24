import crypto from 'node:crypto';
import { ApiError } from './contract.js';
import { readSettings, writeSettings } from './session.js';

export const PROMPT_MARKERS = new Set(['worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription', 'dialogueExamples', 'chatHistory']);
const ROLES = ['system', 'user', 'assistant'];
const TRIGGERS = ['normal', 'quiet', 'regenerate', 'continue', 'impersonate', 'swipe'];

/** Select the upstream global order; old packaged settings used 100000. */
export function activePromptOrder(oai: any) {
    const orders = Array.isArray(oai.prompt_order) ? oai.prompt_order : [];
    return orders.find((item: any) => String(item.character_id) === '100001')
        ?? orders.find((item: any) => String(item.character_id) === '100000');
}

function effectivePrompts(oai: any) {
    const prompts = Array.isArray(oai.prompts) ? [...oai.prompts] : [];
    for (const identifier of PROMPT_MARKERS) {
        if (!prompts.some(prompt => prompt.identifier === identifier)) prompts.push({ identifier, name: identifier, marker: true, system_prompt: true });
    }
    return prompts;
}

function document(settings: any) {
    const oai = settings.oai_settings ?? {};
    const prompts = effectivePrompts(oai);
    const selected = activePromptOrder(oai);
    const order = (selected?.order ?? prompts.map(prompt => ({ identifier: prompt.identifier, enabled: prompt.enabled !== false }))).filter((entry: any) => prompts.some(prompt => prompt.identifier === entry.identifier));
    // The old packaged global order predates the personaDescription marker.
    if (String(selected?.character_id) === '100000' && !order.some((entry: any) => entry.identifier === 'personaDescription')) {
        const index = order.findIndex((entry: any) => entry.identifier === 'charDescription');
        order.splice(index < 0 ? 0 : index, 0, { identifier: 'personaDescription', enabled: true });
    }
    // Source preparation adds absent dynamic field markers, and absence is not
    // an explicit disable. Expose that effective state in the native editor.
    for (const identifier of PROMPT_MARKERS) {
        if (!['chatHistory', 'dialogueExamples'].includes(identifier) && !order.some((entry: any) => entry.identifier === identifier)) order.push({ identifier, enabled: true });
    }
    const config = { prompts, order };
    return { ...config, revision: crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex') };
}

export function readPromptManager(session: any) {
    return document(readSettings(session.directories));
}
export function promptManagerConfiguration(settings: any) { return document(settings); }

/** Validate bounded native edits without dropping opaque upstream prompt/order fields. */
export function validatePromptManager(config: any) {
    const fail = (message: any) => { throw new ApiError(400, 'validation', message); };
    if (!config || !Array.isArray(config.prompts) || !Array.isArray(config.order)) fail('prompts and order must be arrays.');
    if (config.prompts.length > 128 || config.order.length > 128 || Buffer.byteLength(JSON.stringify(config)) > 524288) fail('Prompt configuration exceeds its limit.');
    const ids = new Set();
    for (const prompt of config.prompts) {
        if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt) || typeof prompt.identifier !== 'string' || !/^[\w-]{1,128}$/.test(prompt.identifier) || ids.has(prompt.identifier)) fail('Prompt identifiers must be unique, nonempty ASCII identifiers.');
        ids.add(prompt.identifier);
        if (prompt.role !== undefined && !ROLES.includes(prompt.role)) fail('Prompt role must be system, user or assistant.');
        if (prompt.content !== undefined && typeof prompt.content !== 'string') fail('Prompt content must be text.');
        if (prompt.name !== undefined && typeof prompt.name !== 'string') fail('Prompt name must be text.');
        if (prompt.marker && !PROMPT_MARKERS.has(prompt.identifier)) fail('Unknown prompt marker.');
        if (prompt.injection_position !== undefined && ![0, 1].includes(prompt.injection_position)) fail('Invalid injection position.');
        if (prompt.injection_position === 1 && ['chatHistory', 'dialogueExamples'].includes(prompt.identifier)) fail('History and example collections cannot be depth-injected.');
        if (prompt.injection_depth !== undefined && (!Number.isInteger(prompt.injection_depth) || prompt.injection_depth < 0 || prompt.injection_depth > 10000)) fail('Injection depth must be an integer from 0 to 10000.');
        if (prompt.injection_order !== undefined && (!Number.isInteger(prompt.injection_order) || Math.abs(prompt.injection_order) > 10000)) fail('Injection priority must be an integer from -10000 to 10000.');
        if (prompt.injection_trigger !== undefined && (!Array.isArray(prompt.injection_trigger) || !prompt.injection_trigger.every((trigger: any) => TRIGGERS.includes(trigger)))) fail('Unknown generation trigger.');
        for (const field of ['marker', 'system_prompt', 'forbid_overrides', 'enabled']) {
            if (prompt[field] !== undefined && typeof prompt[field] !== 'boolean') fail(`${field} must be a boolean.`);
        }
    }
    const ordered = new Set();
    for (const entry of config.order) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !ids.has(entry.identifier) || ordered.has(entry.identifier) || typeof entry.enabled !== 'boolean') fail('Order entries must reference unique prompts and include an enabled boolean.');
        ordered.add(entry.identifier);
    }
}

export function savePromptManager(session: any, body: any) {
    const settings = readSettings(session.directories);
    const current = document(settings);
    if (typeof body?.expectedRevision !== 'string' || body.expectedRevision !== current.revision) throw new ApiError(409, 'conflict', 'Prompt configuration changed. Reload before saving.');
    const config = { prompts: body.prompts, order: body.order };
    validatePromptManager(config);
    const oai = settings.oai_settings ??= {};
    oai.prompts = config.prompts;
    const orders = Array.isArray(oai.prompt_order) ? oai.prompt_order : [];
    // Publish the current upstream global ID. Preserve old and per-character orders.
    oai.prompt_order = [...orders.filter((item: any) => String(item.character_id) !== '100001'), { ...(activePromptOrder(oai) ?? {}), character_id: 100001, order: config.order }];
    writeSettings(session.directories, settings);
    return document(settings);
}
