import fs from 'node:fs';
import path from 'node:path';

import { createMacroContext } from './macros.js';
import { upstreamMacroScript } from './macro-runtime/index.js';
import { Handlebars } from './macro-runtime/platform.js';
import { assembleManagedPrompt, activePromptOrder } from './prompt-manager.js';
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
 * Gets active World Info content from global books and the embedded character book.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {Record<string, any>} character Character data
 * @param {Array<Record<string, any>>} chat Chat messages
 * @returns {{before: string, after: string, activated: string[]}} Activated World Info
 */
export function getWorldInfo(session, character, chat) {
    const wiSettings = session.settings.world_info_settings?.world_info ?? {};
    const selected = Array.isArray(wiSettings.globalSelect) ? [...wiSettings.globalSelect] : [];
    const personaBook = session.settings.power_user?.persona_description_lorebook;
    if (typeof personaBook === 'string' && personaBook && !selected.includes(personaBook)) selected.push(personaBook);
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
export function buildPrompt(session, character, chat, { type, input = '', overrides = {}, ...macroOptions }) {
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
    const personaPosition = Number(settings.power_user?.persona_description_position ?? 0);
    if (![0, 1, 4, 9].includes(personaPosition) && settings.power_user?.persona_description) {
        throw new ApiError(422, 'unsupported', 'Persona author-note placement is not yet supported in headless mode.');
    }
    const context = createMacroContext(session, character, chat, { type, input, overrides, extensions: listExtensions(session), ...macroOptions });
    const macro = (text, original) => context.expand(text, typeof original === 'string' ? { original } : {});
    const regexUserInput = text => applyGlobalRegex(text, session.extensionSettings, regex_placement.USER_INPUT);
    const worldInfo = getWorldInfo(session, character, chat);
    const fields = context.fields();
    const maxContextMessages = Math.max(1, Number(oai.openai_max_context ?? settings.max_context ?? 16));
    const history = chat.slice(-Math.min(maxContextMessages, 64));
    const transcript = chat.filter(message => typeof message?.mes === 'string');
    const firstIncluded = history.find(message => typeof message?.mes === 'string');
    context.frame.metadata.lastInContextMessageId = Math.max(0, transcript.indexOf(firstIncluded));
    const historyMessages = history.filter(message => typeof message?.mes === 'string').map(message => ({
        role: message.is_system ? 'system' : message.is_user ? 'user' : 'assistant', content: regexUserInput(macro(message.mes)),
    }));
    if (oai.new_chat_prompt) historyMessages.unshift({ role: 'system', content: macro(String(oai.new_chat_prompt)) });
    const examples = [];
    for (const example of context.examples(fields.mesExamples ?? '')) {
        const parsed = context.run(() => upstreamMacroScript.substituteParams(example));
        const individual = context.run(() => context.frame.exampleParser(parsed));
        if (individual.length && oai.new_example_chat_prompt) examples.push({ role: 'system', content: macro(String(oai.new_example_chat_prompt)) });
        examples.push(...individual.map(message => ({ role: 'system', name: message.name, content: regexUserInput(message.content) })));
    }
    const blocks = {
        worldInfoBefore: macro(worldInfo.before), worldInfoAfter: macro(worldInfo.after),
        charDescription: regexUserInput(fields.description),
        charPersonality: regexUserInput(fields.personality && oai.personality_format ? macro(String(oai.personality_format)) : fields.personality),
        scenario: regexUserInput(fields.scenario && oai.scenario_format ? macro(String(oai.scenario_format)) : fields.scenario),
        personaDescription: [0, 1].includes(personaPosition) ? regexUserInput(fields.persona) : '',
    };
    let messages, segments;
    if (activePromptOrder(oai)) {
        const managed = assembleManagedPrompt(oai, blocks, historyMessages, examples, {
            ...character, system_prompt: fields.system, post_history_instructions: fields.jailbreak,
        }, type, macro, personaPosition === 4 && fields.persona ? [{
            role: ['system', 'user', 'assistant'][Number(settings.power_user?.persona_description_role ?? 0)] ?? 'system',
            content: regexUserInput(fields.persona),
            injection_depth: Math.max(0, Math.min(100, Number(settings.power_user?.persona_description_depth ?? 2))), injection_order: 100,
        }] : []);
        messages = managed.messages;
        segments = managed.segments;
    } else {
        const configured = Array.isArray(oai.prompts) ? oai.prompts : [];
        const main = configured.find(prompt => prompt.identifier === 'main' && prompt.enabled !== false);
        const systemPrompt = oai.use_sysprompt !== false && settings.power_user?.sysprompt?.enabled !== false ? macro(String(main?.content ?? settings.power_user?.sysprompt?.content ?? '')) : '';
        const storyFields = { ...fields, wiBefore: blocks.worldInfoBefore, wiAfter: blocks.worldInfoAfter, persona: blocks.personaDescription, char: characterName, user: session.userName, system: systemPrompt };
        let story = context.run(() => Handlebars.compile(String(settings.power_user?.context?.story_string ?? '{{description}}\n{{persona}}'), { noEscape: true })(storyFields));
        story = macro(story).replace(/\n{3,}/g, '\n\n').trim();
        messages = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        if (story) messages.push({ role: 'system', content: story });
        messages.push(...examples);
        const start = messages.length;
        messages.push(...historyMessages);
        if (personaPosition === 4 && fields.persona) {
            const depth = Math.max(0, Math.min(100, Number(settings.power_user?.persona_description_depth ?? 2)));
            const role = ['system', 'user', 'assistant'][Number(settings.power_user?.persona_description_role ?? 0)] ?? 'system';
            messages.splice(Math.max(start, messages.length - depth), 0, { role, content: fields.persona });
        }
        const jailbreak = configured.find(prompt => prompt.identifier === 'jailbreak' && prompt.enabled !== false);
        if (jailbreak?.content) messages.push({ role: jailbreak.role ?? 'system', content: macro(jailbreak.content) });
        segments = [{ role: 'system', name: 'storyString', content: story }];
    }
    if (type === 'quiet' && input) messages.push({ role: 'system', content: regexUserInput(macro(input)) });
    const warnings = {
        worldInfoActivated: worldInfo.activated, promptManagerPresets: false,
        promptManagerOrdering: Boolean(activePromptOrder(oai)), instructMode: Boolean(settings.power_user?.instruct?.enabled),
        advancedMacros: false, upstreamMacroEngine: true, macroWarnings: context.frame.warnings,
        macroStateChanges: { local: context.frame.localDirty, global: context.frame.globalDirty },
        extensionPrompts: false, groupChats: false, swipes: true,
    };
    const providerRequest = buildProviderRequest(session, messages, overrides);
    return { messages, segments, providerRequest, warnings, macroEffects: context.effects() };
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
        if (new URL(String(oai.custom_url)).username || new URL(String(oai.custom_url)).password) throw new ApiError(422, 'validation', 'Custom provider URL must not contain embedded credentials.');
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
