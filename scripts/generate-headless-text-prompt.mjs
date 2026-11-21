#!/usr/bin/env node
/** Pure Instruct/context formatters derived from source, without the browser UI. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function generateHeadlessTextPrompt({ check = false } = {}) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const sources = new Map(), files = new Map();
    function source(file) {
        const text = fs.readFileSync(path.join(root, file), 'utf8');
        sources.set(file, crypto.createHash('sha256').update(text).digest('hex')); return text;
    }
    function block(file, name, kind = 'function') {
        const text = source(file), start = new RegExp(`^(?:export )?(?:async )?${kind} ${name}\\b`, 'm').exec(text);
        if (!start) throw new Error(`Missing source ${name}`);
        const lineEnd = text.indexOf('\n', start.index);
        let end;
        if (kind === 'const' && text.slice(start.index, lineEnd).trimEnd().endsWith(';')) end = lineEnd;
        else {
            const finish = (kind === 'const' ? /^};$/m : /^}$/m).exec(text.slice(start.index));
            if (!finish) throw new Error(`Unbounded source ${name}`);
            end = start.index + finish.index + finish[0].length;
        }
        const value = text.slice(start.index, end); return value.startsWith('export ') ? value : 'export ' + value;
    }
    const instruct = 'public/scripts/instruct-mode.js', script = 'public/script.js', power = 'public/scripts/power-user.js';
    let code = 'import { power_user, name1, name2, selected_group, extension_prompt_types, substituteParams, parseExampleIntoIndividual } from \'../platform.js\';\n';
    code += 'import { onlyUnique } from \'./utilities.js\';\n';
    for (const name of ['names_behavior_types', 'force_output_sequence']) code += block(instruct, name, 'const') + '\n';
    for (const name of ['getInstructStoppingSequences', 'formatInstructModeChat', 'formatInstructModeSystemPrompt', 'formatInstructModeStoryString', 'formatInstructModeExamples', 'formatInstructModePrompt']) code += block(instruct, name) + '\n';
    files.set('instruct.js', code);
    code = 'import { power_user, extension_prompt_types, extension_prompt_roles, Handlebars, substituteParams, accountStorage, getStringHash, toastr, diagnosticConsole as console, main_api, nai_settings, name1, name2, IGNORE_SYMBOL, extension_prompts } from \'../platform.js\';\nimport { formatInstructModeChat } from \'./instruct.js\';\n';
    code += block('public/scripts/system-messages.js', 'system_message_types', 'const') + '\n';
    code += block(power, 'storage_keys', 'const') + '\n';
    code += block(script, 'MAX_INJECTION_DEPTH', 'const') + '\n';
    code += block('public/scripts/constants.js', 'inject_ids', 'const') + '\n';
    code += block('public/scripts/personas.js', 'persona_description_positions', 'const') + '\n';
    code += "import { collapseNewlines } from './utilities.js';\n";
    code += block(script, 'baseChatReplace') + '\n';
    for (const name of ['getExtensionPrompt', 'getExtensionPromptMaxDepth']) code += block(script, name) + '\n';
    for (const name of ['renderStoryString', 'validateStoryString']) code += block(power, name) + '\n';
    for (const name of ['formatMessageHistoryItem', 'doChatInject', 'addChatsPreamble', 'addChatsSeparator']) code += block(script, name) + '\n';
    files.set('context.js', code);
    code = '';
    code += block('public/scripts/utils.js', 'onlyUnique') + '\n';
    for (const name of ['shiftUpByOne', 'shiftDownByOne']) code += block('public/scripts/utils.js', name, 'const') + '\n';
    code += block(power, 'collapseNewlines') + '\n';
    files.set('utilities.js', code);
    // Preserve Generate's string packing, not a parallel approximation. Explicit
    // sentinels fail closed when upstream moves/replaces either source region.
    function region(start, end) {
        const text = source(script), from = text.indexOf(start);
        if (from < 0 || text.indexOf(start, from + 1) >= 0) throw new Error(`Ambiguous text packing start ${start}`);
        const to = text.indexOf(end, from + start.length);
        if (to < 0) throw new Error(`Missing text packing end ${end}`);
        return text.slice(from, to).replace(/^    /gm, '');
    }
    code = `import { power_user, main_api, nai_settings, name1, name2, extension_prompt_types, extension_prompt_roles, substituteParams, setExtensionPrompt, getTokenCountAsync, setInContextMessages, eventSource, event_types, diagnosticConsole as console } from '../platform.js';
import { getExtensionPrompt, renderStoryString, doChatInject, formatMessageHistoryItem, addChatsPreamble, addChatsSeparator, baseChatReplace, inject_ids, persona_description_positions } from './context.js';
import { formatInstructModeStoryString, formatInstructModeChat, formatInstructModePrompt, force_output_sequence } from './instruct.js';
import { shiftUpByOne, shiftDownByOne, collapseNewlines } from './utilities.js';
import { getGuidanceScale, getCfgPrompt } from './cfg.js';
export async function packTextPrompt({ coreChat, chat, description = '', personality = '', persona = '', scenario = '', system = '', jailbreak = '', worldInfoBefore = '', worldInfoAfter = '', mesExamplesArray = [], mesExamplesRawArray = [], type = 'normal', dryRun = false, quiet_prompt = '', quietToLoud = false, quietName = null, promptBias = '', force_name2 = false, this_max_context }) {
const isInstruct = !!power_user.instruct.enabled, isContinue = type === 'continue', isImpersonate = type === 'impersonate';
const oai_settings = {};
let is_send_press = false;
const nativeLayouts = {};
const nativeNewestMessage = coreChat.at(-1);
let nativeNewestFormatted = null;
`;
    code += region('    // Fetches the combined prompt for both negative and positive prompts', '    console.log(`Core/all messages:');
    let historyPacking = region('    // Prepare the system prompt for Text Completion APIs', '    let oaiMessages = [];');
    const newestBoundary = '    if (coreChat[j].is_user) {';
    if (historyPacking.split(newestBoundary).length !== 2) throw new Error('Missing source newest-message trace boundary');
    historyPacking = historyPacking.replace(newestBoundary, '    if (coreChat[j] === nativeNewestMessage) nativeNewestFormatted = chat2[i];\n' + newestBoundary);
    code += historyPacking;
    let packing = region("    let examplesString = '';", '    let finalPrompt = await getCombinedPrompt(false);');
    const trackedLine = "mesSend[mesSend.length] = { message: item, extensionPrompts: [] };";
    if (packing.split(trackedLine).length !== 2) throw new Error('Missing source message trace boundary');
    // Trace only: retain the pre-trim string to prove which message survived the
    // source fitter, including checkPromptSize removing additional old rows.
    packing = packing.replace('arrMes.forEach(function (item, i, arr) {', 'arrMes.forEach(function (item, i, arr) {\n    const nativeOriginalMessage = item;');
    packing = packing.replace(trackedLine, "mesSend[mesSend.length] = { message: item, extensionPrompts: [], nativeOriginalMessage };");
    const layoutBoundary = '        let combinedPrompt = [';
    if (packing.split(layoutBoundary).length !== 2) throw new Error('Missing source combined string trace boundary');
    packing = packing.replace(layoutBoundary, `        const joined = finalMesSend.map(e => e.extensionPrompts.join('') + e.message).join('');
        if (!mesSendString.endsWith(joined)) throw new Error('Unsupported source string prefix layout');
        nativeLayouts[isNegative ? 'negative' : 'positive'] = {
            story: combinedStoryString, examples: power_user.pin_examples ? mesExamplesArray.slice() : mesExamplesArray.slice(0, count_exm_add),
            prefix: mesSendString.slice(0, mesSendString.length - joined.length),
            messages: finalMesSend.map(e => ({ text: e.extensionPrompts.join('') + e.message, original: e.nativeOriginalMessage, injected: e.injected })),
            continuation: generatedPromptCache,
        };
` + layoutBoundary);
    code += packing;
    code += `const prompt = await getCombinedPrompt(false);
const eventData = { prompt, dryRun };
await eventSource.emit(event_types.GENERATE_AFTER_COMBINE_PROMPTS, eventData);
return { prompt: eventData.prompt, negativePrompt: useCfgPrompt ? await getCombinedPrompt(true) : null, guidanceScale: useCfgPrompt ? cfgGuidanceScale.value : null, effectiveContext: this_max_context, historyCount: mesSend.length, exampleCount: power_user.pin_examples ? mesExamplesArray.length : count_exm_add, continuation: generatedPromptCache, storyString: combinedStoryString, examplesString: mesExmString, newestHistoryIncluded: isContinue ? !!generatedPromptCache : mesSend.some(item => item.nativeOriginalMessage === nativeNewestFormatted), newestFormatted: nativeNewestFormatted, nativeLayouts, sendPressed: is_send_press };
}\n`;
    files.set('packing.js', code);
    code = 'import { names_behavior_types } from \'./instruct.js\';\nimport { extension_prompt_types, extension_prompt_roles } from \'../platform.js\';\n';
    for (const name of ['defaultStoryString', 'defaultExampleSeparator', 'defaultChatStart']) code += block(power, name, 'const') + '\n';
    for (const field of ['instruct', 'context']) {
        const match = new RegExp(`^    ${field}: \\{\\n[\\s\\S]*?^    },`, 'm').exec(source(power));
        if (!match) throw new Error(`Missing source ${field} defaults`);
        code += match[0].replace(new RegExp(`^    ${field}: `), `export const default${field === 'instruct' ? 'Instruct' : 'Context'}Settings = `).replace(/,$/, ';') + '\n';
    }
    files.set('defaults.js', code);
    const textgen = 'public/scripts/textgen-settings.js', tokenizer = 'public/scripts/tokenizers.js';
    code = "import { textgen_settings as textgenerationwebui_settings, toastr, t } from '../platform.js';\n";
    code += block(textgen, 'textgen_types', 'const') + '\n';
    code += 'const { GENERIC, MANCER, VLLM, APHRODITE, TABBY, TOGETHERAI, OOBA, OLLAMA, LLAMACPP, INFERMATICAI, DREAMGEN, OPENROUTER, KOBOLDCPP, HUGGINGFACE, FEATHERLESS } = textgen_types;\n';
    code += block(textgen, 'getTextGenModel') + '\n';
    files.set('models.js', code);
    code = "import { main_api, nai_settings, online_status, sessionStorage, kai_flags, textgen_settings, getCurrentOpenRouterModelTokenizer, getCurrentDreamGenModelTokenizer } from '../platform.js';\nimport { textgen_types, getTextGenModel } from './models.js';\n";
    for (const name of ['TOKENIZER_WARNING_KEY', 'TOKENIZER_SUPPORTED_KEY', 'tokenizers', 'TEXTGEN_TOKENIZERS', 'TOKENIZER_URLS']) code += block(tokenizer, name, 'const') + '\n';
    code += block(tokenizer, 'getTokenizerBestMatch') + '\n';
    files.set('tokenizers.js', code);
    code = "import { extension_settings, chat_metadata, this_chid, selected_group, getCharaFilename, substituteParams, diagnosticConsole as console } from '../platform.js';\n";
    for (const name of ['cfgType', 'metadataKeys']) code += block('public/scripts/cfg-scale.js', name, 'const') + '\n';
    for (const name of ['getGuidanceScale', 'getCustomSeparator', 'getCfgPrompt']) code += block('public/scripts/cfg-scale.js', name) + '\n';
    files.set('cfg.js', code);
    code = "import { power_user, substituteParams, selected_group, name2, getRegexedString } from '../platform.js';\nimport { regex_placement } from '../../regex-runtime.js';\n";
    code += block('public/scripts/reasoning.js', 'PromptReasoning', 'class') + '\n';
    code += "export function applyPromptReasoning(coreChat, type) {\nconst isContinue = type === 'continue';\n";
    code += region('    const promptReasoning = new PromptReasoning();', '    // Determine token limit');
    code += '\nreturn coreChat;\n}\n';
    files.set('reasoning.js', code);
    const manifest = { version: 1, sources: Object.fromEntries(sources), files: {} };
    for (const [name, value] of files) {
        files.set(name, '// Generated by scripts/generate-headless-text-prompt.mjs; edit authority or adapter, then regenerate.\n' + value.trimEnd() + '\n');
        manifest.files[name] = crypto.createHash('sha256').update(files.get(name)).digest('hex');
    }
    files.set('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    for (const [name, value] of files) {
        const target = path.join(root, 'src/headless/text-runtime/generated', name);
        if (check) { if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== value) throw new Error(`Stale native text prompt source ${name}`); } else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); }
    }
    console.log(`${check ? 'Verified' : 'Generated'} ${files.size} text prompt files from ${sources.size} authoritative sources.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateHeadlessTextPrompt({ check: process.argv.includes('--check') });
