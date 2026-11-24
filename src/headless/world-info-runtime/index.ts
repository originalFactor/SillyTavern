import { checkWorldInfo, convertCharacterBook, WorldInfoBuffer } from './compat/engine.js';
import { getRegexedString } from './compat/regex.js';
import { configure } from './platform.js';
import { initializeAuthorNote, setFloatingPrompt, addPersonaDescriptionExtensionPrompt } from './compat/authors-note.js';
import { ApiError } from '../contract.js';
import { migrateGlobalRegex, nativeRegexPreset } from '../regex-runtime.js';

const clone = (value: any) => JSON.parse(JSON.stringify(value));
/** Runs only inside the bounded prompt worker; source scanner settings cannot overlap. */
export async function scanWorldInfo(session: any, character: any, chat: any, context: any, fields: any, options: any) {
    const books = options._books ?? {};
    let primary = character.extensions?.world;
    if (Array.isArray(character.character_book?.entries) && (!primary || !books[primary])) {
        primary ||= `__embedded__:${options.characterId ?? ''}`;
        books[primary] = convertCharacterBook(clone(character.character_book));
        const currentCharacter = context.frame.characters[context.frame.characterIndex ?? 0];
        currentCharacter.data.extensions ??= {};
        currentCharacter.data.extensions.world = primary;
    }
    let total = 0;
    for (const book of Object.values(books) as Array<Record<string, any>>) {
        book.entries = Object.fromEntries(Object.entries(book.entries).map(([id, entry]) => {
            const item = entry as Record<string, any>;
            if (!entry || typeof entry !== 'object' || typeof item.content !== 'string') throw new ApiError(422, 'validation', 'World Info entry requires an object and string content.');
            return [id, { ...item, uid: item.uid ?? item.id ?? id }];
        }));
        total += Object.keys(book.entries).length;
    }
    if (total > 20000) throw new ApiError(422, 'validation', 'World Info entry limit exceeded.');
    const extensionSettings = clone(session.extensionSettings);
    extensionSettings.disabledExtensions ??= [];
    extensionSettings.note ??= {};
    extensionSettings.regex = (extensionSettings.regex ?? []).map(migrateGlobalRegex).map((script: any) => ({ ...script, placement: Array.isArray(script.placement) ? script.placement : [], replaceString: String(script.replaceString ?? ''), trimStrings: script.trimStrings ?? [], substituteRegex: script.substituteRegex ?? 0 }));
    const frame = { context, books, characterId: options.characterId, settings: session.settings.world_info_settings, extensionSettings, loops: 0, diagnostics: [], tagMap: session.settings.tag_map ?? {}, ...nativeRegexPreset(session.settings) };
    configure(frame, getRegexedString);
    initializeAuthorNote();
    setFloatingPrompt();
    WorldInfoBuffer.externalActivations.clear();
    const previousTimed = JSON.stringify(context.frame.metadata.timedWorldInfo);
    const messages = chat.filter((message: any) => typeof message?.mes === 'string');
    const includeNames = session.settings.world_info_settings?.world_info_include_names !== false;
    const scan = messages.map((message: any) => includeNames ? `${message.name ?? (message.is_user ? context.frame.userName : character.name)}: ${message.mes}` : message.mes).reverse();
    if (options.type === 'quiet' && options.input) context.frame.extensionPrompts.native_quiet_prompt = { value: options.input, scan: true };
    const result = await checkWorldInfo(scan, context.frame.maxContext - context.frame.maxResponse, !!options.preview, {
        personaDescription: fields.persona ?? '', characterDescription: fields.description ?? '', characterPersonality: fields.personality ?? '',
        characterDepthPrompt: fields.charDepthPrompt ?? '', scenario: fields.scenario ?? '', creatorNotes: fields.creatorNotes ?? '', trigger: options.type,
    });
    delete context.frame.extensionPrompts.native_quiet_prompt;
    if (previousTimed === undefined && (Object.values(context.frame.metadata.timedWorldInfo ?? {}) as Array<Record<string, any>>).every(value => Object.keys(value).length === 0)) delete context.frame.metadata.timedWorldInfo;
    if (!options.preview && previousTimed !== JSON.stringify(context.frame.metadata.timedWorldInfo)) context.frame.localDirty = true;
    for (const [name, value] of Object.entries(result.outletEntries)) context.frame.extensionPrompts[`customWIOutlet_${name}`] = { value: value.join('\n') };
    for (const entry of result.WIDepthEntries) context.frame.extensionPrompts[`customDepthWI_${entry.depth}_${entry.role}`] = { value: entry.entries.join('\n'), position: 1, depth: entry.depth, scan: false, role: entry.role };
    addPersonaDescriptionExtensionPrompt();
    const roles = ['system', 'user', 'assistant'];
    const note = context.frame.extensionPrompts['2_floating_prompt'];
    const authorNotes = note?.value ? [{ role: roles[note.role] ?? 'system', content: note.value, ...(note.position === 1 ? { injection_depth: note.depth ?? 4, injection_order: 100 } : { relativeToMain: note.position === 2 ? 'start' : 'end' }) }] : [];
    return {
        before: result.worldInfoBefore, after: result.worldInfoAfter,
        activated: [...result.allActivatedEntries].map(entry => `${entry.world}:${entry.uid}`),
        examples: result.EMEntries,
        depth: result.WIDepthEntries.map(entry => ({ role: roles[entry.role] ?? 'system', content: entry.entries.join('\n'), injection_depth: entry.depth ?? 4, injection_order: 100 })),
        authorNotes, warnings: frame.diagnostics,
    };
}
