import { createMacroContext } from './macros.js';
import { upstreamMacroScript } from './macro-runtime/index.js';
import { Handlebars } from './macro-runtime/platform.js';
import { assembleManagedPrompt, activePromptOrder } from './prompt-manager.js';
import { ApiError } from './contract.js';
import { applyGlobalRegex, regex_placement } from './regex.js';
import { listExtensions } from './prompt-settings.js';
import { scanWorldInfo } from './world-info-runtime/index.js';

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
 * Builds deterministic Chat Completion messages from ST data.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {Record<string, any>} character Character data
 * @param {Array<Record<string, any>>} chat Chat messages
 * @param {object} options Generation options
 * @param {string} options.type Generation type
 * @param {string} [options.input] User input or quiet prompt
 * @returns {BuiltPrompt} Built prompt
 */
export async function buildPromptInline(session, character, chat, { type, input = '', overrides = {}, ...macroOptions }) {
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
    if (![0, 1, 2, 3, 4, 9].includes(personaPosition) && settings.power_user?.persona_description) {
        throw new ApiError(422, 'unsupported', 'Unknown Persona placement.');
    }
    const context = createMacroContext(session, character, chat, { type, input, overrides, extensions: macroOptions.extensions ?? listExtensions(session), ...macroOptions });
    const macro = (text, original) => context.expand(text, typeof original === 'string' ? { original } : {});
    const regexUserInput = text => applyGlobalRegex(text, session.extensionSettings, regex_placement.USER_INPUT);
    const fields = context.fields();
    const worldInfo = await scanWorldInfo(session, character, chat, context, fields, { type, input, ...macroOptions });
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
    const exampleBlocks = context.examples(fields.mesExamples ?? '');
    for (const entry of worldInfo.examples) {
        const parsed = context.examples(context.expand(entry.content));
        if (entry.position === 0) exampleBlocks.unshift(...parsed); else exampleBlocks.push(...parsed);
    }
    for (const example of exampleBlocks) {
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
    const injections = [...worldInfo.depth, ...worldInfo.authorNotes];
    let messages, segments;
    if (activePromptOrder(oai)) {
        const managed = assembleManagedPrompt(oai, blocks, historyMessages, examples, {
            ...character, system_prompt: fields.system, post_history_instructions: fields.jailbreak,
        }, type, macro, (personaPosition === 4 && fields.persona ? [{
            role: ['system', 'user', 'assistant'][Number(settings.power_user?.persona_description_role ?? 0)] ?? 'system',
            content: regexUserInput(fields.persona),
            injection_depth: Math.max(0, Math.min(100, Number(settings.power_user?.persona_description_depth ?? 2))), injection_order: 100,
        }] : []).concat(injections));
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
        if (systemPrompt) messages.push(...injections.filter(entry => entry.relativeToMain === 'start').map(({ role, content }) => ({ role, content })), { role: 'system', content: systemPrompt }, ...injections.filter(entry => entry.relativeToMain === 'end').map(({ role, content }) => ({ role, content })));
        if (story) messages.push({ role: 'system', content: story });
        messages.push(...examples);
        const start = messages.length;
        messages.push(...historyMessages);
        if (personaPosition === 4 && fields.persona) {
            const depth = Math.max(0, Math.min(100, Number(settings.power_user?.persona_description_depth ?? 2)));
            const role = ['system', 'user', 'assistant'][Number(settings.power_user?.persona_description_role ?? 0)] ?? 'system';
            messages.splice(Math.max(start, messages.length - depth), 0, { role, content: fields.persona });
        }
        for (const entry of injections.filter(entry => !entry.relativeToMain)) messages.splice(Math.max(start, messages.length - entry.injection_depth), 0, { role: entry.role, content: entry.content });
        const jailbreak = configured.find(prompt => prompt.identifier === 'jailbreak' && prompt.enabled !== false);
        if (jailbreak?.content) messages.push({ role: jailbreak.role ?? 'system', content: macro(jailbreak.content) });
        segments = [{ role: 'system', name: 'storyString', content: story }];
    }
    if (type === 'quiet' && input) messages.push({ role: 'system', content: regexUserInput(macro(input)) });
    const warnings = {
        worldInfoActivated: worldInfo.activated, promptManagerPresets: false,
        promptManagerOrdering: Boolean(activePromptOrder(oai)), instructMode: Boolean(settings.power_user?.instruct?.enabled),
        advancedMacros: false, upstreamMacroEngine: true, worldInfoScanner: true, worldInfoWarnings: worldInfo.warnings, macroWarnings: context.frame.warnings,
        macroStateChanges: { local: context.frame.localDirty, global: context.frame.globalDirty },
        extensionPrompts: false, groupChats: false, swipes: true,
    };
    return { messages, segments, warnings, macroEffects: context.effects() };
}
