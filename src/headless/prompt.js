import fs from 'node:fs';
import path from 'node:path';

import { ApiError } from './contract.js';
import { applyGlobalRegex, regex_placement } from './regex.js';
import { readWorldInfoFile } from '../endpoints/worldinfo.js';
import { serverDirectory } from '../server-directory.js';
import { isValidUrl } from '../util.js';

/**
 * @typedef {object} PromptSegment
 * @property {string} role Prompt role
 * @property {string} name Segment name
 * @property {string} content Segment content
 */

/**
 * @typedef {object} BuiltPrompt
 * @property {Array<{role: string, content: string}>} messages Chat Completion messages
 * @property {PromptSegment[]} segments Inspectable prompt segments
 * @property {Record<string, any>} providerRequest Provider request body derived from saved settings
 * @property {Record<string, any>} warnings Unsupported ST features
 */

/**
 * Expands the basic macros supported by the headless MVP.
 * @param {string} text Input text
 * @param {Record<string, string>} variables Macro variables
 * @returns {string} Expanded text
 */
export function substituteBasicMacros(text, variables) {
    return String(text ?? '').replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, key) => {
        if (Object.hasOwn(variables, key)) {
            return variables[key];
        }
        return match;
    });
}

/**
 * Gets active World Info content from global books and the embedded character book.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {Record<string, any>} character Character data
 * @param {Array<Record<string, any>>} chat Chat messages
 * @returns {{before: string, after: string, activated: string[]}} Activated World Info
 */
export function getWorldInfo(session, character, chat) {
    const wiSettings = session.settings.world_info_settings?.world_info ?? {};
    const selected = Array.isArray(wiSettings.globalSelect) ? wiSettings.globalSelect : [];
    const scanDepth = Math.max(1, Number(session.settings.world_info_settings?.world_info_depth ?? 2));
    const recentText = chat.slice(-scanDepth * 2).map(message => String(message.mes ?? '')).join('\n');
    const books = [];
    for (const name of selected) {
        try {
            const book = readWorldInfoFile(session.directories, String(name), true);
            if (book?.entries) books.push({ name: String(name), entries: book.entries });
        } catch (error) {
            console.warn('[api-v1] Ignoring unreadable World Info book:', name, error instanceof Error ? error.message : error);
        }
    }
    if (character.character_book?.entries) {
        books.push({ name: 'embedded', entries: character.character_book.entries });
    }
    if (books.length === 0) {
        return { before: '', after: '', activated: [] };
    }

    const matches = [];
    const caseSensitive = Boolean(session.settings.world_info_settings?.world_info_case_sensitive);
    const wholeWords = Boolean(session.settings.world_info_settings?.world_info_match_whole_words);
    const haystack = caseSensitive ? recentText : recentText.toLowerCase();
    for (const book of books) {
        for (const entry of Object.values(book.entries)) {
            if (!entry || entry.disable) continue;
            const keys = Array.isArray(entry.key) ? entry.key : String(entry.key ?? '').split(',').map(key => key.trim()).filter(Boolean);
            const matched = keys.some(key => {
                const needle = caseSensitive ? String(key) : String(key).toLowerCase();
                if (!needle) return false;
                if (!wholeWords) return haystack.includes(needle);
                const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`\\b${escaped}\\b`, caseSensitive ? '' : 'i').test(recentText);
            });
            if (matched) {
                matches.push({ book: book.name, entry });
            }
        }
    }
    matches.sort((left, right) => Number(right.entry.order ?? 0) - Number(left.entry.order ?? 0) || Number(right.entry.position ?? 0) - Number(left.entry.position ?? 0));
    const budget = Number(session.settings.world_info_settings?.world_info_budget ?? 25);
    const limited = Number.isFinite(budget) && budget > 0 ? matches.slice(0, budget) : matches;
    const before = [];
    const after = [];
    for (const { entry } of limited) {
        const content = String(entry.content ?? '');
        if (entry.position === 1 || entry.role === 1) {
            after.push(content);
        } else {
            before.push(content);
        }
    }
    return {
        before: before.join('\n'),
        after: after.join('\n'),
        activated: limited.map(({ book, entry }) => `${book}:${entry.id ?? entry.comment ?? entry.key ?? 'entry'}`),
    };
}

function splitMessageExamples(mesExample) {
    return String(mesExample ?? '')
        .replace(/<START>/gi, '\n')
        .split(/\n{2,}/)
        .map(block => block.trim())
        .filter(Boolean)
        .slice(0, 8);
}

function applyStoryString(template, fields) {
    return substituteBasicMacros(template, fields)
        .replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_match, key, body) => fields[key] ? body : '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Builds deterministic Chat Completion messages from ST data.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {Record<string, any>} character Character data
 * @param {Array<Record<string, any>>} chat Chat messages
 * @param {object} options Generation options
 * @param {string} options.type Generation type
 * @param {string} [options.input] User input or quiet prompt
 * @returns {BuiltPrompt} Built prompt
 */
export function buildPrompt(session, character, chat, { type, input = '', overrides = {} }) {
    const settings = session.settings;
    if (settings.main_api !== 'openai') {
        throw new ApiError(422, 'unsupported', `main_api "${settings.main_api}" is not supported by API v1 MVP.`);
    }
    const oai = settings.oai_settings ?? {};
    const source = String(oai.chat_completion_source ?? 'openai');
    if (!['openai', 'custom'].includes(source)) {
        throw new ApiError(422, 'unsupported', `chat_completion_source "${source}" is not supported by API v1 MVP.`);
    }

    const characterName = String(character.name || 'Character');
    const variables = {
        user: session.userName,
        char: characterName,
        persona: String(settings.power_user?.persona_description ?? ''),
    };
    const macro = text => substituteBasicMacros(text, variables);
    const regexUserInput = text => applyGlobalRegex(text, session.extensionSettings, regex_placement.USER_INPUT);
    const worldInfo = getWorldInfo(session, character, chat);
    const contextTemplate = String(settings.power_user?.context?.story_string ?? '{{description}}\n{{persona}}');
    const story = applyStoryString(contextTemplate, {
        system: macro(String(settings.power_user?.sysprompt?.content ?? '')),
        wiBefore: macro(worldInfo.before),
        description: regexUserInput(macro(String(character.description ?? ''))),
        personality: regexUserInput(macro(String(character.personality ?? ''))),
        scenario: regexUserInput(macro(String(character.scenario ?? ''))),
        wiAfter: macro(worldInfo.after),
        persona: regexUserInput(macro(variables.persona)),
        char: characterName,
        user: session.userName,
    });
    const configuredPrompts = Array.isArray(oai.prompts) ? oai.prompts : [];
    const mainPrompt = configuredPrompts.find(prompt => prompt.identifier === 'main' && prompt.enabled !== false);
    const jailbreakPrompt = configuredPrompts.find(prompt => prompt.identifier === 'jailbreak' && prompt.enabled !== false);
    const useSysprompt = oai.use_sysprompt !== false && settings.power_user?.sysprompt?.enabled !== false;
    const systemPrompt = useSysprompt
        ? macro(String(mainPrompt?.content ?? settings.power_user?.sysprompt?.content ?? ''))
        : '';
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    if (story) messages.push({ role: 'system', content: story });

    const examples = splitMessageExamples(character.mes_example);
    for (const example of examples) {
        const lines = example.split('\n').filter(Boolean);
        for (const line of lines) {
            const role = line.startsWith(`${session.userName}:`) || line.startsWith('User:') ? 'user' : 'assistant';
            const content = line.replace(/^[^:]+:\s*/, '');
            messages.push({ role, content: regexUserInput(macro(content)) });
        }
    }

    const maxContextMessages = Math.max(1, Number(settings.oai_settings?.openai_max_context ?? settings.max_context ?? 16));
    const history = chat.slice(-Math.min(maxContextMessages, 64));
    for (const message of history) {
        if (!message || typeof message.mes !== 'string') continue;
        messages.push({
            role: message.is_user ? 'user' : 'assistant',
            content: regexUserInput(macro(message.mes)),
        });
    }
    if (type === 'quiet' && input) {
        messages.push({ role: 'system', content: regexUserInput(macro(input)) });
    }
    const jailbreak = macro(String(jailbreakPrompt?.content ?? ''));
    if (jailbreak) {
        messages.push({ role: 'system', content: jailbreak });
    }

    const segments = [
        { role: 'system', name: 'systemPrompt', content: systemPrompt },
        { role: 'system', name: 'storyString', content: story },
        { role: 'system', name: 'jailbreak', content: jailbreak },
        { role: 'system', name: 'worldInfoBefore', content: worldInfo.before },
        { role: 'system', name: 'worldInfoAfter', content: worldInfo.after },
        { role: 'examples', name: 'messageExamples', content: examples.join('\n\n') },
        { role: 'chat', name: 'messages', content: String(history.length) },
    ];
    const warnings = {
        worldInfoActivated: worldInfo.activated,
        promptManagerPresets: false,
        instructMode: Boolean(settings.power_user?.instruct?.enabled),
        advancedMacros: false,
        extensionPrompts: false,
        groupChats: false,
        swipes: true,
    };
    const providerRequest = buildProviderRequest(session, messages, overrides);
    return { messages, segments, providerRequest, warnings };
}

/**
 * Builds a provider request from saved settings only.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {Array<{role: string, content: string}>} messages Chat Completion messages
 * @returns {Record<string, any>} Provider request
 */
export function buildProviderRequest(session, messages, overrides = {}) {
    const oai = session.settings.oai_settings ?? {};
    const source = String(oai.chat_completion_source ?? 'openai');
    const model = overrides.model ?? (source === 'custom' ? oai.custom_model : oai.openai_model);
    if (!model) {
        throw new ApiError(422, 'validation', 'No Chat Completion model is configured.');
    }
    const request = {
        chat_completion_source: source,
        model: String(model),
        messages,
        temperature: overrides.temperature ?? Number(oai.temp_openai ?? 1),
        max_tokens: overrides.maxTokens ?? Number(oai.openai_max_tokens ?? session.settings.amount_gen ?? 300),
        max_completion_tokens: overrides.maxTokens ?? Number(oai.openai_max_tokens ?? session.settings.amount_gen ?? 300),
        frequency_penalty: overrides.frequencyPenalty ?? Number(oai.freq_pen_openai ?? 0),
        presence_penalty: overrides.presencePenalty ?? Number(oai.pres_pen_openai ?? 0),
        top_p: overrides.topP ?? Number(oai.top_p_openai ?? 1),
        stream: true,
    };
    if (Array.isArray(overrides.stop) && overrides.stop.length > 0) request.stop = overrides.stop.slice(0, 4).map(String);
    if (source === 'custom') {
        if (!oai.custom_url) {
            throw new ApiError(422, 'validation', 'No custom OpenAI-compatible URL is configured.');
        }
        if (!isValidUrl(String(oai.custom_url)) || !/^https?:$/.test(new URL(String(oai.custom_url)).protocol)) {
            throw new ApiError(422, 'validation', 'Custom OpenAI-compatible URL must be an HTTP(S) URL.');
        }
        request.custom_url = String(oai.custom_url);
        request.custom_include_body = String(oai.custom_include_body ?? '');
        request.custom_exclude_body = String(oai.custom_exclude_body ?? '');
        request.custom_include_headers = String(oai.custom_include_headers ?? '');
    }
    return request;
}

/**
 * Reads and classifies extension manifests for API v1 clients.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @returns {Array<Record<string, any>>} Extensions
 */
export function listExtensions(session) {
    const roots = [
        { type: 'system', directory: path.join(serverDirectory, 'public', 'scripts', 'extensions') },
        { type: 'local', directory: session.directories.extensions },
        { type: 'global', directory: path.join(serverDirectory, 'public', 'scripts', 'extensions', 'third-party') },
    ];
    const extensions = [];
    for (const root of roots) {
        if (!fs.existsSync(root.directory)) continue;
        const entries = fs.readdirSync(root.directory, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && entry.name !== 'third-party');
        for (const entry of entries) {
            const manifestPath = path.join(root.directory, entry.name, 'manifest.json');
            if (!fs.existsSync(manifestPath)) continue;
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                const id = root.type === 'system' ? entry.name : `${root.type}/${entry.name}`;
                const disabled = Array.isArray(session.extensionSettings.disabledExtensions)
                    && session.extensionSettings.disabledExtensions.includes(id.replace(/^local\//, 'third-party/').replace(/^global\//, 'third-party/'));
                extensions.push({
                    id,
                    displayName: String(manifest.display_name ?? entry.name),
                    version: String(manifest.version ?? ''),
                    type: root.type,
                    runtime: ['headless', 'webview', 'legacy'].includes(manifest.runtime) ? manifest.runtime : 'legacy',
                    enabled: !disabled,
                    entry: typeof manifest.entry === 'string' ? manifest.entry : null,
                    ui: typeof manifest.ui === 'string' ? manifest.ui : null,
                    capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
                    hooks: manifest.hooks && typeof manifest.hooks === 'object' ? Object.keys(manifest.hooks) : [],
                    shellUrl: `/api/v1/extensions/${encodeURIComponent(id)}/shell`,
                });
            } catch (error) {
                console.warn('[api-v1] Ignoring invalid extension manifest:', manifestPath, error instanceof Error ? error.message : error);
            }
        }
    }
    return extensions;
}
