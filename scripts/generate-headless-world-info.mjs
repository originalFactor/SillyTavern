#!/usr/bin/env node
/** Source-derived WI evaluator, independently verifiable without shipping the SPA. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function generateHeadlessWorldInfo({ check = false } = {}) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const sources = new Map(), files = new Map();
    const source = name => { const text = fs.readFileSync(path.join(root, name), 'utf8'); sources.set(name, crypto.createHash('sha256').update(text).digest('hex')); return text; };
    function block(file, name, kind = 'function') {
        const text = source(file);
        const match = new RegExp(`^(?:export )?(?:async )?${kind} ${name}\\b`, 'm').exec(text);
        if (!match) throw new Error(`Missing authoritative ${kind} ${name}`);
        const frozen = kind === 'const' && text.slice(match.index, match.index + 100).includes('Object.freeze(');
        const end = text.indexOf(kind === 'const' ? (frozen ? '\n});' : '\n};') : '\n}', match.index);
        if (end < 0) throw new Error(`Unbounded source: ${name}`);
        const value = text.slice(match.index, end + (kind === 'const' ? (frozen ? 4 : 3) : 2));
        return value.startsWith('export ') ? value : 'export ' + value;
    }
    const wi = 'public/scripts/world-info.js';
    const constants = ['world_info_insertion_strategy', 'world_info_logic', 'scan_state', 'world_info_position', 'wi_anchor_position'];
    let engine = 'import { world_info, selected_world_info, world_info_depth, world_info_min_activations, world_info_min_activations_depth_max, world_info_budget, world_info_include_names, world_info_recursive, world_info_overflow_alert, world_info_case_sensitive, world_info_match_whole_words, world_info_use_group_scoring, world_info_character_strategy, world_info_budget_cap, world_info_max_recursion_steps, chat_metadata, characters, this_chid, power_user, extension_settings, extension_prompt_roles, getContext, getCharaFilename, loadWorldInfo, eventSource, event_types, getStringHash, escapeRegex, getTokenCountAsync, getExtensionPromptByName, substituteParams, getTagKeyForEntity, getRegexedString, regex_placement, shouldWIAddPrompt, NOTE_MODULE_NAME, metadata_keys, toastr, diagnosticConsole as console, Math } from \'../platform.js\';\n';
    engine += constants.map(name => block(wi, name, 'const')).join('\n');
    engine += '\n' + ['DEFAULT_DEPTH', 'DEFAULT_WEIGHT', 'MAX_SCAN_DEPTH', 'KNOWN_DECORATORS'].map(name => source(wi).match(new RegExp(`^(?:export )?const ${name} = .+;`, 'm'))?.[0] ?? (() => { throw new Error(name); })()).join('\n');
    engine += '\nconst METADATA_KEY = \'world_info\';\nconst sortFn = (a,b) => b.order-a.order;\n';
    engine += block(wi, 'defaultGlobalScanData', 'const').replace('export const ', 'const ') + '\n';
    engine += ['WorldInfoBuffer', 'WorldInfoTimedEffects'].map(name => block(wi, name, 'class')).join('\n') + '\n';
    const helpers = ['parseRegexFromString', 'getCharacterLore', 'getGlobalLore', 'getChatLore', 'getPersonaLore', 'getSortedEntries', 'parseDecorators', 'checkWorldInfo', 'filterGroupsByScoring', 'filterGroupsByTimedEffects', 'filterByInclusionGroups', 'convertCharacterBook'];
    engine += helpers.map(name => block(wi, name)).join('\n\n');
    engine += '\n' + block(wi, 'newWorldInfoEntryDefinition', 'const') + '\n';
    engine += 'export const newWorldInfoEntryTemplate = Object.fromEntries(Object.entries(newWorldInfoEntryDefinition).filter(([,v]) => !v.excludeFromTemplate).map(([k,v]) => [k,v.default]));\n';
    engine = engine.replace('console.error(e);\n        return [];', 'throw e;'); // Native errors must remain visible.
    engine = engine.replace('const WIOutletEntries = {};', 'const WIOutletEntries = Object.create(null);');
    engine = engine.replace('        return acc;\n    }, {});', '        return acc;\n    }, Object.create(null));');
    engine = engine.replace('GENERATION_TYPE_TRIGGERS.includes(value)', '[\'normal\',\'continue\',\'regenerate\',\'swipe\',\'quiet\',\'impersonate\'].includes(value)');
    files.set('engine.js', engine);
    const regex = 'public/scripts/extensions/regex/engine.js';
    let regexCode = 'import { extension_settings, characters, this_chid, substituteParams, substituteParamsExtended, getPresetManager, diagnosticConsole as console } from \'../platform.js\';\n';
    regexCode += block('public/scripts/utils.js', 'regexFromString') + '\n';
    regexCode += block(regex, 'SCRIPT_TYPES', 'const') + '\nconst SCRIPT_TYPE_UNKNOWN=-1;\nconst DEFAULT_GET_REGEX_SCRIPTS_OPTIONS={allowedOnly:false};\n';
    regexCode += block(regex, 'RegexProvider', 'class') + '\n';
    regexCode += ['getRegexScripts', 'getScriptsByType', 'isScopedScriptsAllowed', 'isPresetScriptsAllowed', 'getCurrentPresetAPI', 'getCurrentPresetName'].map(name => block(regex, name)).join('\n') + '\n';
    regexCode += ['regex_placement', 'substitute_find_regex'].map(name => block(regex, name, 'const')).join('\n') + '\n';
    regexCode += ['sanitizeRegexMacro', 'getRegexedString', 'runRegexScript', 'filterString'].map(name => block(regex, name)).join('\n');
    files.set('regex.js', regexCode);
    const authorFile = 'public/scripts/authors-note.js';
    const authorSource = source(authorFile);
    const defaultsStart = authorSource.indexOf('function loadSettings() {');
    const defaultsEnd = authorSource.indexOf('    $(\'#extension_floating_prompt\').val', defaultsStart);
    if (defaultsStart < 0 || defaultsEnd < 0) throw new Error('Missing authoritative note defaults');
    let author = 'import { getContext, chat_metadata, power_user, extension_settings, extension_prompt_roles, extension_prompt_types, MAX_INJECTION_DEPTH, getCharaFilename, setExtensionPrompt, extension_prompts, shouldWIAddPrompt, setShouldWIAddPrompt, NOTE_MODULE_NAME, metadata_keys, $, diagnosticConsole as console } from \'../platform.js\';\nconst MODULE_NAME=NOTE_MODULE_NAME;\n';
    author += block(authorFile, 'chara_note_position', 'const') + '\n';
    author += block('public/scripts/personas.js', 'persona_description_positions', 'const') + '\n';
    author += authorSource.slice(defaultsStart, defaultsEnd).replace('function loadSettings()', 'export function initializeAuthorNote()') + '}\n';
    author += block(authorFile, 'setFloatingPrompt').replace(/shouldWIAddPrompt = ([^;]+);/g, 'setShouldWIAddPrompt($1);') + '\n';
    author += block('public/script.js', 'addPersonaDescriptionExtensionPrompt') + '\n';
    files.set('authors-note.js', author);

    const prefix = '// Generated by scripts/generate-headless-world-info.mjs; edit authority or adapter, then regenerate.\n';
    const manifest = { version: 1, sources: Object.fromEntries(sources), files: {} };
    for (const [name, value] of files) { files.set(name, prefix + value.trimEnd() + '\n'); manifest.files[name] = crypto.createHash('sha256').update(files.get(name)).digest('hex'); }
    files.set('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    for (const [name, value] of files) {
        const target = path.join(root, 'src/headless/world-info-runtime/generated', name);
        if (check) { if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== value) throw new Error(`Stale native WI source: ${name}`); } else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); }
    }
    console.log(`${check ? 'Verified' : 'Generated'} ${files.size} WI/regex files from ${sources.size} authoritative sources.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateHeadlessWorldInfo({ check: process.argv.includes('--check') });
