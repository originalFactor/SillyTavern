import crypto from 'node:crypto';
import { ApiError } from './contract.js';
import { readSettings, writeSettings } from './session.js';

export const PROMPT_MARKERS = new Set(['worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription', 'dialogueExamples', 'chatHistory']);
const ROLES = ['system', 'user', 'assistant'];
const TRIGGERS = ['normal', 'quiet', 'regenerate', 'continue', 'impersonate', 'swipe'];

/** Select the upstream global order; old packaged settings used 100000. */
export function activePromptOrder(oai) {
    const orders = Array.isArray(oai.prompt_order) ? oai.prompt_order : [];
    return orders.find(item => String(item.character_id) === '100001')
        ?? orders.find(item => String(item.character_id) === '100000');
}

function effectivePrompts(oai) {
    const prompts = Array.isArray(oai.prompts) ? [...oai.prompts] : [];
    for (const identifier of PROMPT_MARKERS) {
        if (!prompts.some(prompt => prompt.identifier === identifier)) prompts.push({ identifier, name: identifier, marker: true, system_prompt: true });
    }
    return prompts;
}

function document(settings) {
    const oai = settings.oai_settings ?? {};
    const prompts = effectivePrompts(oai);
    const selected = activePromptOrder(oai);
    const order = (selected?.order ?? prompts.map(prompt => ({ identifier: prompt.identifier, enabled: prompt.enabled !== false }))).filter(entry => prompts.some(prompt => prompt.identifier === entry.identifier));
    // The old packaged global order predates the personaDescription marker.
    if (String(selected?.character_id) === '100000' && !order.some(entry => entry.identifier === 'personaDescription')) {
        const index = order.findIndex(entry => entry.identifier === 'charDescription');
        order.splice(index < 0 ? 0 : index, 0, { identifier: 'personaDescription', enabled: true });
    }
    const config = { prompts, order };
    return { ...config, revision: crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex') };
}

export function readPromptManager(session) {
    return document(readSettings(session.directories));
}

/** Validate bounded native edits without dropping opaque upstream prompt/order fields. */
export function validatePromptManager(config) {
    const fail = message => { throw new ApiError(400, 'validation', message); };
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
        if (prompt.injection_depth !== undefined && (!Number.isInteger(prompt.injection_depth) || prompt.injection_depth < 0 || prompt.injection_depth > 100)) fail('Injection depth must be an integer from 0 to 100.');
        if (prompt.injection_order !== undefined && (!Number.isInteger(prompt.injection_order) || Math.abs(prompt.injection_order) > 10000)) fail('Injection priority must be an integer from -10000 to 10000.');
        if (prompt.injection_trigger !== undefined && (!Array.isArray(prompt.injection_trigger) || !prompt.injection_trigger.every(trigger => TRIGGERS.includes(trigger)))) fail('Unknown generation trigger.');
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

export function savePromptManager(session, body) {
    const settings = readSettings(session.directories);
    const current = document(settings);
    if (typeof body?.expectedRevision !== 'string' || body.expectedRevision !== current.revision) throw new ApiError(409, 'conflict', 'Prompt configuration changed. Reload before saving.');
    const config = { prompts: body.prompts, order: body.order };
    validatePromptManager(config);
    const oai = settings.oai_settings ??= {};
    oai.prompts = config.prompts;
    const orders = Array.isArray(oai.prompt_order) ? oai.prompt_order : [];
    // Publish the current upstream global ID. Preserve old and per-character orders.
    oai.prompt_order = [...orders.filter(item => String(item.character_id) !== '100001'), { ...(activePromptOrder(oai) ?? {}), character_id: 100001, order: config.order }];
    writeSettings(session.directories, settings);
    return document(settings);
}

/** Assemble the supported Prompt Manager subset, shared by preview and dispatch. */
export function assembleManagedPrompt(oai, blocks, history, examples, character, type, expand, extraInjections = []) {
    const selected = activePromptOrder(oai);
    if (!selected) return null; // retain legacy story-string behavior for old API clients
    const config = document({ oai_settings: oai });
    validatePromptManager(config);
    const prompts = new Map(config.prompts.map(prompt => [prompt.identifier, prompt]));
    const ordered = [];
    const absolute = [...extraInjections];
    const segments = [];
    for (const entry of config.order) {
        const prompt = prompts.get(entry.identifier);
        if (!entry.enabled || (prompt.injection_trigger?.length && !prompt.injection_trigger.includes(type))) continue;
        const id = prompt.identifier;
        const role = prompt.role ?? 'system';
        const original = String(prompt.content ?? '');
        const override = id === 'main' ? character.system_prompt : id === 'jailbreak' ? character.post_history_instructions : '';
        let content = Object.hasOwn(blocks, id) ? blocks[id] : (override && !prompt.forbid_overrides ? override : original);
        content = expand(String(content ?? ''), original);
        const messages = id === 'chatHistory' ? history.map(message => ({ ...message }))
            : id === 'dialogueExamples' ? examples.map(message => ({ ...message })) : content ? [{ role, content }] : [];
        segments.push({ name: id, role, content: ['chatHistory', 'dialogueExamples'].includes(id) ? String(messages.length) : content });
        if (prompt.injection_position === 1) absolute.push({ ...prompt, role, content });
        else ordered.push({ id, messages });
    }
    // Upstream injects into reversed history, grouping descending priority then
    // system/user/assistant, before reversing the completed history again.
    const historyBlock = ordered.find(block => block.id === 'chatHistory');
    if (historyBlock) {
        const reversed = [...historyBlock.messages].reverse();
        let inserted = 0;
        for (let depth = 0; depth <= 100; depth++) {
            const atDepth = absolute.filter(prompt => (prompt.injection_depth ?? 4) === depth && prompt.content);
            const priorities = [...new Set(atDepth.map(prompt => prompt.injection_order ?? 100))].sort((a, b) => b - a);
            const injected = [];
            for (const priority of priorities) {
                for (const role of ROLES) {
                    const content = atDepth.filter(prompt => (prompt.injection_order ?? 100) === priority && prompt.role === role).map(prompt => prompt.content).join('\n').trim();
                    if (content) injected.push({ role, content });
                }
            }
            reversed.splice(Math.min(reversed.length, depth + inserted), 0, ...injected);
            inserted += injected.length;
        }
        historyBlock.messages = reversed.reverse();
    } else if (absolute.some(prompt => prompt.content)) {
        throw new ApiError(422, 'unsupported', 'Depth-injected prompts require an enabled chatHistory marker.');
    }
    return { messages: ordered.flatMap(block => block.messages), segments };
}
