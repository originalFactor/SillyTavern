import crypto from 'node:crypto';
import { ApiError } from './contract.js';
import { localChat } from './macro-management.js';
import { assertChatIdle } from './generation-store.js';
import { runNativeText } from './prompt.js';
import { persistMacroEffects } from './macros.js';
import { readCharacter, mutateChat, pageChat } from './session.js';

const revision = (chat: any) => crypto.createHash('sha256').update(JSON.stringify(chat)).digest('hex');
export async function renderedChatPage(session: any, characterId: any, chatId: any, options: any) {
    const character = await readCharacter(session, characterId);
    const { chat } = localChat(session, characterId, chatId);
    const page = pageChat(chat, options);
    const result: any = await runNativeText(session, character.data, chat, { mode: 'display', characterId, chatId, nativeContext: options.nativeContext ?? {}, messages: page.messages.filter((message: any) => typeof message.mes === 'string') });
    const views = new Map<number, Record<string, any>>(result.messages.map((message: any) => [message.index, message] as [number, Record<string, any>]));
    const warnings = [...result.warnings];
    if (result.discardedVariableEffects) warnings.push('Display regex proposed variable changes; transcript reads never save these effects.');
    let attached = false;
    page.messages = page.messages.map((message: any) => {
        const view = views.get(message.index);
        if (!view) return message;
        const diagnostics = !attached && warnings.length ? { native_regex_warnings: warnings } : {};
        attached = true;
        return { ...message, native_display: view.display, native_display_reasoning: view.displayReasoning, ...diagnostics };
    });
    return page;
}

/** Awaiting regex must not let a stale editor overwrite a newer transcript. */
export async function mutateNativeMessage(session: any, characterId: any, chatId: any, operation: any) {
    assertChatIdle(session.handle, characterId, chatId, session.directories);
    const { file, chat } = localChat(session, characterId, chatId);
    if (!['append', 'edit'].includes(operation.action) || typeof operation.message?.mes !== 'string') return mutateChat(file, operation);
    if (operation.action === 'edit' && (!Number.isInteger(operation.index) || operation.index < 1 || operation.index >= chat.length)) throw new ApiError(404, 'not_found', 'Message index is out of range.');
    const original = revision(chat);
    const character = await readCharacter(session, characterId);
    const message = operation.action === 'edit' ? { ...chat[operation.index], ...operation.message } : operation.message;
    const result: any = await runNativeText(session, character.data, chat, { mode: operation.action, characterId, chatId, nativeContext: operation.nativeContext ?? {}, message });
    assertChatIdle(session.handle, characterId, chatId, session.directories);
    if (revision(localChat(session, characterId, chatId).chat) !== original) throw new ApiError(409, 'conflict', 'Transcript changed during regex evaluation. Reload before editing; your draft has not been applied.');
    try {
        persistMacroEffects(session, file, chat, result.macroEffects);
        const prepared = { ...operation.message, mes: result.text };
        if (result.warnings.regexWarnings.length || result.warnings.macroWarnings.length || Object.hasOwn(message.extra ?? {}, 'native_regex_warnings') || Object.hasOwn(message.extra ?? {}, 'native_macro_warnings')) {
            prepared.extra = { ...message.extra, native_regex_warnings: result.warnings.regexWarnings, native_macro_warnings: result.warnings.macroWarnings };
        }
        return mutateChat(file, { ...operation, message: prepared });
    } catch {
        throw new ApiError(500, 'unknown', 'Message publication could not be confirmed after regex evaluation. Inspect the transcript and variables before saving again.');
    }
}
