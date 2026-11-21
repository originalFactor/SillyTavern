#!/usr/bin/env node
/** Derive prompt assembly, token packing and reasoning from the browser authority. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function generateHeadlessPromptManager({ check = false } = {}) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const sources = new Map(), files = new Map();
    function source(file) {
        const text = fs.readFileSync(path.join(root, file), 'utf8');
        sources.set(file, crypto.createHash('sha256').update(text).digest('hex'));
        return text;
    }
    function block(file, name, kind = 'function') {
        const text = source(file);
        const match = new RegExp(`^(?:export )?(?:async )?${kind} ${name}\\b`, 'm').exec(text);
        if (!match) throw new Error(`Missing source ${kind} ${name}`);
        let end;
        if (kind === 'const') {
            const lineEnd = text.indexOf('\n', match.index);
            if (text.slice(match.index, lineEnd).trimEnd().endsWith(';')) end = lineEnd;
            else {
                const finish = /^(?:};|\];|\}\);)$/m.exec(text.slice(lineEnd));
                if (!finish) throw new Error(`Unbounded source constant ${name}`);
                end = lineEnd + finish.index + finish[0].length;
            }
        } else {
            const finish = /^}$/m.exec(text.slice(match.index));
            if (!finish) throw new Error(`Unbounded source ${name}`);
            end = match.index + finish.index + 1;
        }
        const value = text.slice(match.index, end);
        return value.startsWith('export ') ? value : 'export ' + value;
    }
    const openai = 'public/scripts/openai.js', manager = 'public/scripts/PromptManager.js', script = 'public/script.js';
    function method(name) {
        const text = source(manager);
        const start = new RegExp(`^    (?:async )?${name}\\(`, 'm').exec(text);
        if (!start) throw new Error(`Missing manager method ${name}`);
        const finish = /^ {4}}$/m.exec(text.slice(start.index));
        if (!finish) throw new Error(`Unbounded manager method ${name}`);
        return text.slice(start.index, start.index + finish.index + finish[0].length);
    }
    let code = 'import { substituteParams } from \'../platform.js\';\n' + block(manager, 'DEFAULT_ORDER', 'const') + '\n';
    code += block(manager, 'INJECTION_POSITION', 'const') + '\n';
    code += block(manager, 'Prompt', 'class') + '\n' + block(manager, 'PromptCollection', 'class') + '\n';
    code += 'export class NativePromptManager {\n';
    code += '    constructor(settings, tokenHandler) { this.serviceSettings=settings; this.tokenHandler=tokenHandler; this.activeCharacter={id:100001}; }\n';
    const methods = ['getActiveGroupCharacters', 'getPromptOrderForCharacter', 'getPromptOrderEntry', 'getPromptById', 'isPromptDisabledForActiveCharacter', 'preparePrompt', 'isValidName', 'sanitizeName', 'getPromptCollection', 'shouldTrigger', 'setMessages', 'setChatCompletion', 'populateTokenCounts'];
    code += methods.map(method).join('\n') + '\n    log() {}\n    render() {}\n}\n';
    // Fail packaging if authority changes the global identity used by API edits.
    if (!/dummyId: 100001/.test(source(openai))) throw new Error('Native prompt global identity needs migration');
    files.set('manager.js', code);

    code = 'import { tokenHandler, promptManager, oai_settings, power_user, selected_group, ToolManager, isImageInliningSupported, isVideoInliningSupported, isAudioInliningSupported, isReasoningSignatureSupported, extension_prompt_roles, extension_prompt_types, extension_prompts, substituteParams, substituteParamsExtended, isDataURL, fetch, getBase64Async, createThumbnail, getImageSizeFromDataURL, getVideoDurationFromDataURL, getAudioDurationFromDataURL, t, toastr, eventSource, event_types, diagnosticConsole as console } from \'../platform.js\';\nimport { Prompt, INJECTION_POSITION } from \'./manager.js\';\n';
    for (const name of ['chat_completion_sources', 'character_names_behavior', 'tool_reasoning_modes', 'interleaved_reasoning_providers']) code += block(openai, name, 'const') + '\n';
    for (const name of ['MEDIA_DISPLAY', 'MEDIA_TYPE']) code += block('public/scripts/constants.js', name, 'const') + '\n';
    code += block('public/scripts/personas.js', 'persona_description_positions', 'const') + '\n';
    code += block(script, 'MAX_INJECTION_DEPTH', 'const') + '\n';
    const quality = /^ {4}inline_image_quality: (.+),$/m.exec(source(openai));
    if (!quality) throw new Error('Missing source image quality default');
    code += `const default_settings={inline_image_quality:${quality[1]}};\n`;
    const defaultSettingsSource = block(openai, 'default_settings', 'const');
    const fields = ['openai_max_context', 'openai_max_tokens', 'new_chat_prompt', 'new_group_chat_prompt', 'new_example_chat_prompt', 'continue_nudge_prompt', 'send_if_empty', 'wi_format', 'group_nudge_prompt', 'scenario_format', 'personality_format', 'continue_prefill', 'names_behavior', 'assistant_prefill', 'impersonation_prompt', 'squash_system_messages', 'show_thoughts', 'tool_reasoning_mode'];
    const values = new Map(), dependencies = new Set();
    for (const key of fields) {
        const value = new RegExp(`^    ${key}: (.+),$`, 'm').exec(defaultSettingsSource)?.[1];
        if (!value) throw new Error(`Missing source default ${key}`);
        values.set(key, value);
        for (const id of value.match(/\b(?:default_\w+|max_4k)\b/g) ?? []) dependencies.add(id);
    }
    for (const id of dependencies) code += block(openai, id, 'const') + '\n';
    code += 'export const nativeChatDefaults={' + [...values].map(([key, value]) => `${key}:${value}`).join(',') + '};\n';

    code += block('public/scripts/utils.js', 'stringFormat') + '\n';
    for (const name of ['TokenHandler', 'IdentifierNotFoundError', 'TokenBudgetExceededError', 'InvalidCharacterNameError', 'Message', 'MessageCollection', 'ChatCompletion']) code += block(openai, name, 'class') + '\n';
    for (const name of ['getExtensionPrompt', 'getExtensionPromptMaxDepth']) code += block(script, name) + '\n';
    for (const name of ['formatWorldInfo', 'populationInjectionPrompts', 'populateChatHistory', 'populateDialogueExamples', 'getPromptPosition', 'getPromptRole', 'populateChatCompletion', 'preparePromptsForChatCompletion', 'getToolReasoningMode', 'getEffectiveToolReasoningMode']) code += block(openai, name) + '\n';
    let prepare = block(openai, 'prepareOpenAIMessages');
    const caught = prepare.indexOf('    } catch (error) {'), finished = prepare.indexOf('    } finally {', caught);
    if (caught < 0 || finished < 0) throw new Error('Missing source prompt failure boundary');
    // Browser UI may inspect a partial failed prompt. A server must not send it.
    prepare = prepare.slice(0, caught) + '    } catch (error) {\n        throw error;\n' + prepare.slice(finished);
    code += 'export let openai_messages_count=0;\n' + prepare + '\n';
    files.set('engine.js', code);

    code = 'import { oai_settings, power_user, selected_group, name1, name2, getChatCompletionModel, IGNORE_SYMBOL } from \'../platform.js\';\nimport { character_names_behavior, MEDIA_DISPLAY } from \'./engine.js\';\n';
    code += block('public/scripts/system-messages.js', 'system_message_types', 'const') + '\n';
    for (const name of ['getMediaDisplay', 'getMediaIndex']) code += block(script, name) + '\n';
    code += block(openai, 'setOpenAIMessages') + '\n';
    const lastContext = block(script, 'setInContextMessages');
    const increment = /^ {4}if \(type[\s\S]*?^ {4}}/m.exec(lastContext);
    const expression = /const lastMessageId = (.+);/.exec(lastContext);
    if (!increment || !expression) throw new Error('Missing source context boundary');
    code += `export function lastContextMessageId(chatLength,msgInContextCount,type) {\n${increment[0]}\nreturn ${expression[1].replace('chat.length', 'chatLength')};\n}\n`;
    files.set('history.js', code);

    let reasoningDefaults = block('public/scripts/reasoning.js', 'DEFAULT_REASONING_TEMPLATE', 'const') + '\n';
    const defaults = /^ {4}reasoning: \{\n[\s\S]*?^ {4}},/m.exec(source('public/scripts/power-user.js'));
    if (!defaults) throw new Error('Missing source reasoning defaults');
    reasoningDefaults += defaults[0].replace(/^ {4}reasoning: /, 'export const defaultReasoningSettings = ').replace(/,$/, ';') + '\n';
    files.set('reasoning-defaults.js', reasoningDefaults);
    code = 'import { power_user, substituteParams, selected_group, name2, getRegexedString } from \'../platform.js\';\nimport { regex_placement } from \'../../regex-runtime.js\';\nexport { defaultReasoningSettings } from \'./reasoning-defaults.js\';\n';
    code += block('public/scripts/reasoning.js', 'PromptReasoning', 'class') + '\n';
    const scriptText = source(script);
    const reasoningStart = scriptText.indexOf('    const promptReasoning = new PromptReasoning();');
    const reasoningEnd = scriptText.indexOf('    // Determine token limit', reasoningStart);
    if (reasoningStart < 0 || reasoningEnd < 0) throw new Error('Missing source reasoning assembly');
    code += 'export function applyPromptReasoning(coreChat,type) {\nconst isContinue=type===\'continue\';\n' + scriptText.slice(reasoningStart, reasoningEnd) + '\nreturn coreChat;\n}\n';
    files.set('reasoning.js', code);

    code = 'import { oai_settings, main_api, textgen_settings, textgen_types, model_list, openRouterModels, getTokenCacheObject, getStringHash, jQuery } from \'../platform.js\';\nimport { chat_completion_sources } from \'./engine.js\';\n';
    code += block('public/scripts/tokenizers.js', 'getTokenizerModel') + '\n';
    code += block('public/scripts/tokenizers.js', 'countTokensOpenAIAsync') + '\n';
    files.set('tokenizers.js', code);

    const prefix = '// Generated by scripts/generate-headless-prompt-manager.mjs; edit authority or adapter and regenerate.\n';
    const manifest = { version: 1, sources: Object.fromEntries(sources), files: {} };
    for (const [name, value] of files) { files.set(name, prefix + value.trimEnd() + '\n'); manifest.files[name] = crypto.createHash('sha256').update(files.get(name)).digest('hex'); }
    files.set('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    for (const [name, value] of files) {
        const target = path.join(root, 'src/headless/prompt-runtime/generated', name);
        if (check) { if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== value) throw new Error(`Stale native prompt source: ${name}`); } else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); }
    }
    console.log(`${check ? 'Verified' : 'Generated'} ${files.size} prompt files from ${sources.size} authoritative sources.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateHeadlessPromptManager({ check: process.argv.includes('--check') });
