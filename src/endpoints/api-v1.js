import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { API_V1_VERSION, ApiError, asyncHandler, ensureRequestId, requireObject, requireSafeId, sendApiError } from '../headless/contract.js';
import { deleteCharacter, exportCharacter, importCharacter, saveCharacter } from '../headless/character-management.js';
import { activePreset, activatePreset, deletePreset, exportPreset, getPreset, listPresets, savePreset } from '../headless/presets.js';
import { publicConfiguration } from '../headless/redaction.js';
import { readPromptManager, savePromptManager } from '../headless/prompt-manager.js';
import { deletePersona, listPersonas, savePersona, selectPersona } from '../headless/persona-management.js';
import {
    assertChatIdle,
    acknowledgeGeneration,
    abandonClientGeneration,
    getGenerationByClient,
    listGenerations,
    cancel,
    createGeneration,
    generationUrls,
    getGeneration,
    isTerminal,
    snapshot,
    subscribe,
} from '../headless/generation-store.js';
import { buildPrompt, listExtensions } from '../headless/prompt.js';
import { createMacroChat } from '../headless/macros.js';
import { renderedChatPage, mutateNativeMessage } from '../headless/message-text.js';
import { getRegexSettings, saveRegexSettings } from '../headless/regex-management.js';
import { readGlobalMacros, readLocalMacros, saveGlobalMacros, saveLocalMacros } from '../headless/macro-management.js';
import { listWorldBooks, getWorldBook, saveWorldBook, deleteWorldBook, exportWorldBook, getWorldSettings, saveWorldSettings, getChatWorldBook, saveChatWorldBook } from '../headless/world-info-management.js';
import { areHeadlessPluginHooksEnabled, HEADLESS_HOOKS } from '../headless/plugin-runtime.js';
import { runGeneration } from '../headless/runtime.js';
import {
    createSession,
    deleteChat,
    isApiV1Enabled,
    listCharacters,
    listChats,
    renameChat,
    patchSettings,
    readCharacter,
    readChatPage,
    readSettings,
    resolveChatPath,
    writeSettings,
} from '../headless/session.js';
import { getConfigValue } from '../util.js';

export const router = express.Router();

router.use((request, _response, next) => {
    if (!isApiV1Enabled()) {
        next(new ApiError(404, 'disabled', 'API v1 is disabled.'));
        return;
    }
    next();
});

router.get('/capabilities', (_request, response) => {
    const headlessPlugins = areHeadlessPluginHooksEnabled();
    response.json({
        version: API_V1_VERSION,
        enabled: true,
        auth: {
            cookieSession: !process.env.SILLYTAVERN_COMPANION_MODE,
            csrf: !process.env.SILLYTAVERN_COMPANION_MODE,
            bearerToken: !!process.env.SILLYTAVERN_COMPANION_MODE,
        },
        resources: {
            session: true,
            settingsRead: true,
            settingsPatch: true,
            characters: true,
            characterCreate: true,
            characterEdit: true,
            characterDelete: true,
            characterImport: true,
            characterExport: true,
            personas: true,
            promptManager: true,
            presets: true,
            chats: true,
            chatCreate: true,
            chatGreetingMacros: true,
            macroManagement: true,
            worldInfoManagement: true,
            renderedTranscript: true,
            regexManagement: true,
            chatDelete: true,
            chatMutate: true,
            chatPaging: true,
            chatRename: true,
            extensions: true,
            extensionSettings: headlessPlugins,
            serverPlugins: !!getConfigValue('enableServerPlugins', false, 'boolean'),
            providerCredentials: true,
        },
        generation: {
            preview: true,
            previewRegenerate: true,
            previewContinue: true,
            normal: true,
            quiet: true,
            regenerate: true,
            continue: true,
            stream: true,
            pollingFallback: true,
            cancel: true,
            idempotency: true,
            overrides: true,
            usage: true,
            restoreAfterRestart: true,
            discovery: true,
            durableAdmission: true,
            acknowledgeUnknown: true,
        },
        providers: {
            chatCompletionsOpenAI: true,
            chatCompletionsOpenAICompatible: true,
            otherChatCompletionSources: false,
            novelai: false,
            kobold: false,
            textgen: false,
            horde: false,
        },
        features: {
            basicMacros: true,
            advancedMacros: false,
            upstreamMacroEngine: true,
            macroVariables: true,
            nativeMacroContext: true,
            worldInfo: true,
            worldInfoScanner: true,
            personaAuthorNote: true,
            globalRegex: true,
            upstreamRegexPaths: true,
            scopedRegex: false,
            promptManagerPresets: false,
            promptManagerOrdering: true,
            sourcePromptAssembly: true,
            promptTokenBudget: true,
            instructMode: false,
            groupChats: false,
            swipes: true,
            toolCalling: false,
            images: false,
            tts: false,
            vectors: false,
            serverPlugins: !!getConfigValue('enableServerPlugins', false, 'boolean'),
            headlessPlugins,
            headlessHooks: headlessPlugins ? Object.values(HEADLESS_HOOKS) : [],
            webviewPluginShell: true,
            legacyWebView: true,
        },
    });
});

router.get('/session', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.json({
        handle: session.handle,
        userName: session.userName,
        csrfTokenUrl: '/csrf-token',
        authenticated: true,
    });
}));

router.get('/settings', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const settings = publicConfiguration(readSettings(session.directories));
    response.json({
        raw: settings,
        typed: {
            username: settings.username,
            main_api: settings.main_api,
            amount_gen: settings.amount_gen,
            max_context: settings.max_context,
            oai_settings: settings.oai_settings,
            world_info_settings: settings.world_info_settings,
            power_user: settings.power_user,
            extension_settings: settings.extension_settings,
        },
    });
}));

router.patch('/settings', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const settings = patchSettings(session.directories, request.body);
    response.json({ raw: publicConfiguration(settings) });
}));

router.get('/macro-variables/global', asyncHandler(async (request, response) => {
    response.json(readGlobalMacros(createSession(request)));
}));
router.get('/regex-settings', asyncHandler(async (request, response) => {
    response.json(getRegexSettings(createSession(request)));
}));
router.put('/regex-settings', asyncHandler(async (request, response) => {
    response.json(saveRegexSettings(createSession(request), request.body));
}));

router.get('/world-info', asyncHandler(async (request, response) => {
    response.json(listWorldBooks(createSession(request)));
}));
router.get('/world-info-settings', asyncHandler(async (request, response) => {
    response.json(getWorldSettings(createSession(request)));
}));
router.put('/world-info-settings', asyncHandler(async (request, response) => {
    response.json(saveWorldSettings(createSession(request), request.body));
}));
router.get('/world-info/:name', asyncHandler(async (request, response) => {
    response.json(getWorldBook(createSession(request), request.params.name));
}));
router.put('/world-info/:name', asyncHandler(async (request, response) => {
    response.json(saveWorldBook(createSession(request), request.params.name, request.body));
}));
router.delete('/world-info/:name', asyncHandler(async (request, response) => {
    response.json(deleteWorldBook(createSession(request), request.params.name, request.query.expectedRevision));
}));
router.get('/world-info/:name/export', asyncHandler(async (request, response) => {
    response.json(exportWorldBook(createSession(request), request.params.name));
}));
router.get('/chats/:chatId/world-info', asyncHandler(async (request, response) => {
    response.json(getChatWorldBook(createSession(request), requireSafeId(request.query.characterId, 'characterId'), request.params.chatId));
}));
router.put('/chats/:chatId/world-info', asyncHandler(async (request, response) => {
    response.json(saveChatWorldBook(createSession(request), requireSafeId(request.query.characterId, 'characterId'), request.params.chatId, request.body));
}));
router.put('/macro-variables/global', asyncHandler(async (request, response) => {
    response.json(saveGlobalMacros(createSession(request), request.body));
}));
router.get('/chats/:chatId/variables', asyncHandler(async (request, response) => {
    response.json(readLocalMacros(createSession(request), requireSafeId(request.query.characterId, 'characterId'), request.params.chatId));
}));
router.put('/chats/:chatId/variables', asyncHandler(async (request, response) => {
    response.json(saveLocalMacros(createSession(request), requireSafeId(request.query.characterId, 'characterId'), request.params.chatId, request.body));
}));

// ---- narrowly scoped provider credentials; secret values are never returned ----

router.get('/presets/:kind', asyncHandler(async (request, response) => {
    response.json(listPresets(createSession(request), request.params.kind));
}));
router.get('/preset-settings/:kind', asyncHandler(async (request, response) => {
    response.json(activePreset(createSession(request), request.params.kind));
}));
router.get('/presets/:kind/:name', asyncHandler(async (request, response) => {
    response.json(getPreset(createSession(request), request.params.kind, request.params.name));
}));
router.put('/presets/:kind/:name', asyncHandler(async (request, response) => {
    response.json(savePreset(createSession(request), request.params.kind, request.params.name, request.body));
}));
router.delete('/presets/:kind/:name', asyncHandler(async (request, response) => {
    response.json(deletePreset(createSession(request), request.params.kind, request.params.name, request.query.expectedRevision));
}));
router.post('/presets/:kind/:name/activate', asyncHandler(async (request, response) => {
    response.json(activatePreset(createSession(request), request.params.kind, request.params.name, request.body));
}));
router.get('/presets/:kind/:name/export', asyncHandler(async (request, response) => {
    response.json(exportPreset(createSession(request), request.params.kind, request.params.name));
}));

router.get('/prompt-manager', asyncHandler(async (request, response) => {
    response.json(readPromptManager(createSession(request)));
}));

router.put('/prompt-manager', asyncHandler(async (request, response) => {
    response.json(savePromptManager(createSession(request), request.body));
}));

router.get('/provider-credentials', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const { readSecret, SECRET_KEYS } = await import('./secrets.js');
    response.json({
        openaiConfigured: Boolean(readSecret(session.directories, SECRET_KEYS.OPENAI)),
        customConfigured: Boolean(readSecret(session.directories, SECRET_KEYS.CUSTOM)),
    });
}));

router.put('/provider-credentials', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const { SECRET_KEYS, writeSecret } = await import('./secrets.js');
    const provider = request.body?.provider;
    const apiKey = request.body?.apiKey;
    const key = provider === 'openai' ? SECRET_KEYS.OPENAI
        : provider === 'custom' ? SECRET_KEYS.CUSTOM
            : null;
    if (!key) throw new ApiError(400, 'validation', 'provider must be "openai" or "custom".');
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0 || apiKey.length > 4096) {
        throw new ApiError(400, 'validation', 'apiKey must be a non-empty string up to 4096 characters.');
    }
    writeSecret(session.directories, key, apiKey.trim());
    response.json({ saved: true, provider });
}));

router.delete('/provider-credentials/:provider', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const { SECRET_KEYS, SecretManager } = await import('./secrets.js');
    const key = request.params.provider === 'openai' ? SECRET_KEYS.OPENAI
        : request.params.provider === 'custom' ? SECRET_KEYS.CUSTOM
            : null;
    if (!key) throw new ApiError(400, 'validation', 'provider must be "openai" or "custom".');
    const manager = new SecretManager(session.directories);
    const entries = manager.getSecretState()[key];
    if (Array.isArray(entries)) {
        for (const entry of entries) manager.deleteSecret(key, entry.id);
    }
    response.json({ deleted: true, provider: request.params.provider });
}));

// ---- extension settings (scoped write, never raw settings) ----

router.get('/extensions/:extensionId/settings', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const name = requireSafeId(request.params.extensionId, 'extensionId');
    response.json({ extensionId: name, settings: session.extensionSettings?.[name] ?? {} });
}));

router.patch('/extensions/:extensionId/settings', asyncHandler(async (request, response) => {
    if (!areHeadlessPluginHooksEnabled()) {
        throw new ApiError(403, 'disabled', 'Headless plugins are disabled; extension settings are read-only.');
    }
    const session = createSession(request);
    const name = requireSafeId(request.params.extensionId, 'extensionId');
    const patch = request.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new ApiError(400, 'validation', 'Extension settings must be a JSON object.');
    }
    const settings = readSettings(session.directories);
    settings.extension_settings ??= {};
    settings.extension_settings[name] = { ...(settings.extension_settings[name] ?? {}), ...patch };
    writeSettings(session.directories, settings);
    response.json({ extensionId: name, settings: settings.extension_settings[name] });
}));

// ---- characters & chats ----

router.get('/characters', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.json(await listCharacters(session));
}));

router.post('/characters', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const input = requireObject(request.body, 'character input');
    response.status(201).json(await saveCharacter(session, { characterId: input.characterId, card: input.card }));
}));

router.post('/characters/import', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.status(201).json(await importCharacter(session, requireObject(request.body, 'import input')));
}));

router.get('/characters/:characterId', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const character = await readCharacter(session, request.params.characterId);
    response.json(character);
}));

router.put('/characters/:characterId', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const input = requireObject(request.body, 'character input');
    response.json(await saveCharacter(session, {
        characterId: request.params.characterId, card: input.card,
        expectedRevision: input.expectedRevision, create: false,
    }));
}));

router.get('/characters/:characterId/export', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.json(await exportCharacter(session, request.params.characterId, String(request.query.format ?? 'json')));
}));

router.delete('/characters/:characterId', asyncHandler(async (request, response) => {
    const session = createSession(request);
    deleteCharacter(session, request.params.characterId, String(request.query.expectedRevision ?? ''), request.query.deleteChats === 'true');
    response.json({ deleted: true });
}));

router.get('/personas', asyncHandler(async (request, response) => {
    response.json(listPersonas(createSession(request)));
}));

router.put('/personas/:personaId', asyncHandler(async (request, response) => {
    response.json(savePersona(createSession(request), request.params.personaId, requireObject(request.body, 'persona input')));
}));

router.post('/personas/:personaId/select', asyncHandler(async (request, response) => {
    const input = requireObject(request.body, 'persona selection');
    response.json(selectPersona(createSession(request), request.params.personaId, input.expectedRevision));
}));

router.delete('/personas/:personaId', asyncHandler(async (request, response) => {
    response.json(deletePersona(createSession(request), request.params.personaId, String(request.query.expectedRevision ?? '')));
}));

router.get('/characters/:characterId/chats', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.json(await listChats(session, request.params.characterId));
}));

router.post('/characters/:characterId/chats', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const chatId = requireSafeId(request.body?.chatId, 'chatId');
    const firstMessage = typeof request.body?.firstMessage === 'string' ? request.body.firstMessage : '';
    const character = await readCharacter(session, request.params.characterId);
    assertChatIdle(session.handle, request.params.characterId, chatId, session.directories);
    const created = await createMacroChat(session, character.data, request.params.characterId, chatId,
        firstMessage || String(character.data.first_mes ?? ''), validateNativeMacroContext(request.body?.nativeContext), listExtensions(session));
    response.status(201).json(created);
}));

router.get('/chats/:chatId', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const characterId = typeof request.query.characterId === 'string' ? request.query.characterId : '';
    requireSafeId(characterId, 'characterId');
    const chatPath = resolveChatPath(session, characterId, request.params.chatId);
    const paging = {
        limit: request.query.limit,
        before: request.query.before,
        after: request.query.after,
    };
    const page = request.query.render === 'true' ? await renderedChatPage(session, characterId, request.params.chatId, paging) : readChatPage(chatPath, paging);
    response.json({ characterId, chatId: request.params.chatId, ...page });
}));

router.post('/chats/:chatId/messages', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const characterId = typeof request.body?.characterId === 'string' ? request.body.characterId : '';
    requireSafeId(characterId, 'characterId');
    const action = String(request.body?.action ?? 'append');
    assertChatIdle(session.handle, characterId, request.params.chatId, session.directories);
    const index = await mutateNativeMessage(session, characterId, request.params.chatId, {
        action,
        message: request.body?.message,
        index: request.body?.index,
        swipeId: request.body?.swipeId,
        nativeContext: validateNativeMacroContext(request.body?.nativeContext),
    });
    response.status(action === 'append' ? 201 : 200).json({ chatId: request.params.chatId, action, index });
}));
router.post('/chats/:chatId/render', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const characterId = requireSafeId(request.body?.characterId, 'characterId');
    const page = await renderedChatPage(session, characterId, request.params.chatId, {
        limit: request.body?.limit, before: request.body?.before, after: request.body?.after,
        nativeContext: validateNativeMacroContext(request.body?.nativeContext),
    });
    response.json({ characterId, chatId: request.params.chatId, ...page });
}));

router.delete('/chats/:chatId', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const characterId = typeof request.query.characterId === 'string' ? request.query.characterId : '';
    requireSafeId(characterId, 'characterId');
    assertChatIdle(session.handle, characterId, request.params.chatId, session.directories);
    if (!deleteChat(session, characterId, request.params.chatId)) {
        throw new ApiError(404, 'not_found', 'Chat not found.');
    }
    response.json({ deleted: true, chatId: request.params.chatId, characterId });
}));

router.patch('/chats/:chatId', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const characterId = typeof request.body?.characterId === 'string' ? request.body.characterId : '';
    const newChatId = typeof request.body?.newChatId === 'string' ? request.body.newChatId : '';
    requireSafeId(characterId, 'characterId');
    assertChatIdle(session.handle, characterId, request.params.chatId, session.directories);
    assertChatIdle(session.handle, characterId, newChatId, session.directories);
    const renamed = renameChat(session, characterId, request.params.chatId, newChatId);
    response.json(renamed);
}));

router.get('/extensions', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.json(listExtensions(session));
}));

// ---- generations ----

router.post('/generations/preview', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const input = validateGenerationInput(request.body);
    const character = await readCharacter(session, input.characterId);
    const chatPath = resolveChatPath(session, input.characterId, input.chatId);
    const { readChat } = await import('../headless/session.js');
    let chat = readChat(chatPath);
    if (chat.length === 0) {
        chat = [{ chat_metadata: {} }, { name: character.name, is_user: false, mes: character.data.first_mes ?? '' }];
    }
    if (input.type === 'normal' && input.input) {
        chat.push({ name: session.userName, is_user: true, mes: input.input });
    }
    if (['regenerate', 'continue'].includes(input.type) && (chat.length <= 1 || chat.at(-1).is_user || typeof chat.at(-1).mes !== 'string')) throw new ApiError(409, 'conflict', 'The last message must be an assistant reply.');
    const macroChat = input.type === 'regenerate' ? [...chat] : null;
    if (input.type === 'regenerate' && chat.length > 1 && !chat.at(-1).is_user) chat.pop();
    const built = await buildPrompt(session, character.data, chat, {
        type: input.type, input: input.input, overrides: input.overrides,
        characterId: input.characterId, chatId: input.chatId, nativeContext: input.nativeContext, preview: true,
        macroChat, stageUserInput: input.type === 'normal' && Boolean(input.input),
    });
    response.json({
        messages: built.messages,
        segments: built.segments,
        warnings: built.warnings,
        providerRequest: publicConfiguration(built.providerRequest),
    });
}));

router.post('/generations', asyncHandler(async (request, response) => {
    const input = validateGenerationInput(request.body);
    const { prepareProviderSession } = await import('../headless/provider.js');
    const session = await prepareProviderSession(request);
    const created = createGeneration({
        handle: session.handle,
        clientRequestId: request.body.clientRequestId,
        characterId: input.characterId,
        chatId: input.chatId,
        type: input.type,
        requestIdentity: input,
        directories: session.directories,
    });
    if (!created.existing) {
        const detachedRequest = {
            user: request.user,
            session: request.session,
            ip: request.ip,
            headers: request.headers,
        };
        void runGeneration(detachedRequest, session, created.record, input);
    }
    response.status(202).json({
        requestId: created.record.requestId,
        status: created.record.status,
        seq: created.record.seq,
        idempotent: created.existing,
        ...generationUrls(created.record.requestId),
    });
    console.info('[api-v1] generation_accepted', JSON.stringify({ requestId: created.record.requestId }));
}));

router.get('/generations', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.json(listGenerations(session.handle, session.directories, {
        characterId: requireSafeId(request.query.characterId, 'characterId'),
        chatId: requireSafeId(request.query.chatId, 'chatId'),
        before: String(request.query.before ?? ''), limit: Number(request.query.limit ?? 20),
        unresolvedOnly: request.query.unresolvedOnly === 'true',
    }));
}));
router.get('/generations/by-client/:clientRequestId', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.json(snapshot(getGenerationByClient(request.params.clientRequestId, session.handle, session.directories)));
}));
router.post('/generations/by-client/:clientRequestId/abandon', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.json(abandonClientGeneration(session.handle, session.directories, request.params.clientRequestId,
        requireSafeId(request.body?.characterId, 'characterId'), requireSafeId(request.body?.chatId, 'chatId')));
}));
router.post('/generations/:requestId/acknowledge', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.json(acknowledgeGeneration(getGeneration(request.params.requestId, session.handle, session.directories), request.body?.expectedSeq));
}));

router.get('/generations/:requestId', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const record = getGeneration(request.params.requestId, session.handle, session.directories);
    response.json(snapshot(record));
}));

router.get('/generations/:requestId/events', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const record = getGeneration(request.params.requestId, session.handle, session.directories);
    const afterSeq = Number(request.query.afterSeq ?? request.headers['last-event-id'] ?? 0);
    const unsubscribe = subscribe(record, response, Number.isFinite(afterSeq) ? afterSeq : 0);
    request.on('close', () => {
        unsubscribe();
        console.info('[api-v1] sse_disconnected', JSON.stringify({ requestId: record.requestId, status: record.status }));
    });
}));

router.post('/generations/:requestId/cancel', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const record = getGeneration(request.params.requestId, session.handle, session.directories);
    const changed = cancel(record, isTerminal(record.status) ? 'unknown' : 'requested');
    response.status(202).json({ outcome: record.cancelOutcome ?? 'unknown', changed, status: record.status });
}));

// ---- extension WebView shell (real context bridge, all runtime tiers) ----

router.get('/extensions/*/shell', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const rawExtensionId = request.params[0];
    const extensionId = rawExtensionId.includes('/') ? rawExtensionId : decodeURIComponent(rawExtensionId);
    const extension = listExtensions(session).find(item => item.id === extensionId);
    if (!extension) {
        throw new ApiError(404, 'not_found', 'Extension not found.');
    }
    // Legacy extensions are served a shell that explains how to open the full UI,
    // rather than a bare 422 that gives the native client nothing to show.
    const uiPath = resolveUiPath(session, extension);
    const uiFile = uiPath ? path.join(extensionDirectory(session, extension), path.basename(extension.ui)) : null;
    const inlineUi = !uiPath || !uiFile || !fs.existsSync(uiFile)
        ? null
        : fs.readFileSync(uiFile, 'utf8').slice(0, 256 * 1024);
    response.type('html').send(renderShell(extension, uiPath, inlineUi, ensureRequestId(request)));
}));

router.use((error, request, response, _next) => sendApiError(response, ensureRequestId(request), error));

/**
 * Resolves the directory of an extension.
 * @param {import('../headless/session.js').HeadlessSession} session Headless session
 * @param {Record<string, any>} extension Extension metadata
 * @returns {string} Extension directory
 */
function extensionDirectory(session, extension) {
    const name = path.basename(String(extension.id));
    const roots = {
        system: path.join(process.cwd(), 'public', 'scripts', 'extensions', name),
        local: path.join(session.directories.extensions, name),
        global: path.join(process.cwd(), 'public', 'scripts', 'extensions', 'third-party', name),
    };
    return roots[extension.type] ?? roots.system;
}

/**
 * Resolves the served UI URL for an extension, including user-installed ones.
 * @param {import('../headless/session.js').HeadlessSession} session Headless session
 * @param {Record<string, any>} extension Extension metadata
 * @returns {string|null} UI URL
 */
function resolveUiPath(session, extension) {
    if (!extension.ui) return null;
    const name = path.basename(String(extension.id));
    const safeUi = path.basename(String(extension.ui));
    if (extension.type === 'system') return `/scripts/extensions/${encodeURIComponent(name)}/${encodeURIComponent(safeUi)}`;
    if (extension.type === 'global') return `/scripts/extensions/third-party/${encodeURIComponent(name)}/${encodeURIComponent(safeUi)}`;
    return `/api/v1/extensions/${encodeURIComponent(String(extension.id))}/ui/${encodeURIComponent(safeUi)}`;
}

/**
 * Validates a generation request.
 * @param {any} body Request body
 * @param {object} options Validation options
 * @param {boolean} options.allowUnsupportedTypes Whether regenerate/continue are accepted
 * @returns {{characterId: string, chatId: string, type: string, input: string, stream: boolean, overrides: Record<string, any>}} Validated input
 */
function validateGenerationInput(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError(400, 'validation', 'Request body must be a JSON object.');
    }
    const type = String(body.type ?? 'normal');
    if (!['normal', 'quiet', 'regenerate', 'continue'].includes(type)) {
        throw new ApiError(400, 'validation', `Unknown generation type "${type}".`);
    }
    const overrides = body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides)
        ? body.overrides : {};
    return {
        characterId: requireSafeId(body.characterId, 'characterId'),
        chatId: requireSafeId(body.chatId, 'chatId'),
        type,
        input: typeof body.input === 'string' ? body.input : '',
        stream: body.stream !== false,
        overrides,
        nativeContext: validateNativeMacroContext(body.nativeContext),
    };
}

/** Only device/UI facts are accepted; scripts, settings and extension grants are server-owned. */
function validateNativeMacroContext(value) {
    if (value == null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'validation', 'nativeContext must be an object.');
    const allowed = new Set(['input', 'firstDisplayedMessageId', 'isMobile', 'locale', 'timeZone', 'lastGenerationType']);
    if (Object.keys(value).some(key => !allowed.has(key))) throw new ApiError(400, 'validation', 'Unknown nativeContext field.');
    const result = {};
    for (const key of ['input', 'locale', 'timeZone', 'lastGenerationType']) {
        if (value[key] === undefined) continue;
        if (typeof value[key] !== 'string' || value[key].length > (key === 'input' ? 1_048_576 : 128)) throw new ApiError(400, 'validation', `Invalid nativeContext.${key}.`);
        result[key] = value[key];
    }
    try {
        if (result.locale) new Intl.Locale(result.locale);
        if (result.timeZone) new Intl.DateTimeFormat('en', { timeZone: result.timeZone });
    } catch { throw new ApiError(400, 'validation', 'Invalid native macro locale or time zone.'); }
    if (result.lastGenerationType && !['normal', 'quiet', 'regenerate', 'continue', 'swipe', 'impersonate'].includes(result.lastGenerationType)) throw new ApiError(400, 'validation', 'Invalid native macro generation type.');
    if (value.isMobile !== undefined) {
        if (typeof value.isMobile !== 'boolean') throw new ApiError(400, 'validation', 'Invalid nativeContext.isMobile.');
        result.isMobile = value.isMobile;
    }
    if (value.firstDisplayedMessageId !== undefined) {
        if (!Number.isSafeInteger(value.firstDisplayedMessageId) || value.firstDisplayedMessageId < 0) throw new ApiError(400, 'validation', 'Invalid nativeContext.firstDisplayedMessageId.');
        result.firstDisplayedMessageId = value.firstDisplayedMessageId;
    }
    return result;
}

/**
 * Renders the same-origin WebView compatibility shell with a real context bridge.
 * @param {Record<string, any>} extension Extension metadata
 * @param {string|null} uiPath UI URL
 * @param {string|null} inlineUi Inlined extension HTML
 * @param {string} requestId Request identifier
 * @returns {string} HTML shell
 */
function renderShell(extension, uiPath, inlineUi, requestId) {
    const config = JSON.stringify({ extension, requestId, apiBase: '/api/v1' }).replace(/</g, '\\u003c');
    const ui = inlineUi
        ? `<div id="extension-ui">${inlineUi}</div>`
        : uiPath
            ? `<iframe id="extension-ui" src="${escapeHtml(uiPath)}" sandbox="allow-scripts allow-same-origin"></iframe>`
            : `<div id="extension-ui"><p>${escapeHtml(extension.displayName)} has no declared UI. Open the full SillyTavern interface to configure it.</p></div>`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'self' data:">
<title>${escapeHtml(extension.displayName)}</title>
<style>body{font:14px sans-serif;margin:0}#extension-ui{width:100%;min-height:100vh;border:0}</style>
</head>
<body>
${ui}
<script>
window.__SILLYTAVERN_API_V1__=${config};
(function(){
  const extensionSettings = Object.create(null);
  const listeners = new Map();
  const eventTypes = {
    APP_READY:'app_ready', MESSAGE_SENT:'message_sent', MESSAGE_RECEIVED:'message_received',
    GENERATION_STARTED:'generation_started', GENERATION_ENDED:'generation_ended',
    SETTINGS_UPDATED:'settings_updated', EXTENSION_SETTINGS_LOADED:'extension_settings_loaded',
    CHAT_CHANGED:'chat_id_changed', CHAT_CREATED:'chat_created', CHAT_DELETED:'chat_deleted',
    STREAM_TOKEN_RECEIVED:'stream_token_received', WORLD_INFO_ACTIVATED:'world_info_activated'
  };
  const eventSource = {
    on(e,h){ const l=listeners.get(e)||[]; l.push(h); listeners.set(e,l); },
    off(e,h){ listeners.set(e,(listeners.get(e)||[]).filter(x=>x!==h)); },
    once(e,h){ const w=d=>{eventSource.off(e,w);h(d);}; eventSource.on(e,w); },
    emit(e,d){ (listeners.get(e)||[]).forEach(h=>{try{h(d);}catch(err){console.warn(err);}}); },
    makeLast(){}
  };
  const getHeaders = () => ({'Content-Type':'application/json','X-CSRF-Token':window.__SILLYTAVERN_CSRF_TOKEN__||''});
  async function api(method, endpoint, body){
    const r = await fetch(window.__SILLYTAVERN_API_V1__.apiBase+endpoint,{method,headers:getHeaders(),body:body?JSON.stringify(body):undefined});
    if(!r.ok){const e=await r.json().catch(()=>({error:{message:r.statusText}}));throw new Error(e.error?.message||r.statusText);}
    return r.json();
  }
  const id = window.__SILLYTAVERN_API_V1__.extension.id;
  const ctx = {
    eventSource, eventTypes, event_types:eventTypes, extensionSettings,
    extensionId:id, extensionName:window.__SILLYTAVERN_API_V1__.extension.displayName,
    getRequestHeaders:getHeaders,
    saveSettingsDebounced(){}, saveSettings(){},
    writeExtensionField(name,field,value,bulk){
      const target=extensionSettings[name]??={};
      if(bulk&&field&&typeof field==='object'){Object.assign(target,field);api('PATCH','/extensions/'+encodeURIComponent(name)+'/settings',field).catch(console.warn);}
      else {target[field]=value;api('PATCH','/extensions/'+encodeURIComponent(name)+'/settings',{[field]:value}).catch(console.warn);}
    },
    writeExtensionFieldBulk(name,fields){ctx.writeExtensionField(name,fields,true);},
    renderExtensionTemplateAsync:async()=>'', renderExtensionTemplate:()=>'',
    substituteParams:(t,v={})=>String(t??'').replace(/\\{\\{\\s*([^{}\\s]+)\\s*\\}\\}/g,(m,k)=>Object.hasOwn(v,k)?String(v[k]):m),
    generate:()=>Promise.reject(new Error('Generation is unavailable inside the extension settings shell.')),
    generateQuietPrompt:()=>Promise.reject(new Error('Generation is unavailable inside the extension settings shell.')),
    registerMacro(){}, unregisterMacro(){}, registerSlashCommand(){}, registerFunctionTool(){}
  };
  window.SillyTavern={getContext:()=>ctx,getContextAsync:async()=>ctx};
  window.addEventListener('message',event=>{
    if(event.source!==parent)return;
    if(event.data?.type==='csrf-token')window.__SILLYTAVERN_CSRF_TOKEN__=String(event.data.token??'');
  });
  api('GET','/extensions/'+encodeURIComponent(id)+'/settings')
    .then(r=>{Object.assign(extensionSettings,r.settings||{});eventSource.emit(eventTypes.EXTENSION_SETTINGS_LOADED,extensionSettings);})
    .catch(err=>console.warn('extension settings unavailable',err));
})();
</script>
</body>
</html>`;
}

/**
 * Escapes HTML text.
 * @param {string} value Input text
 * @returns {string} Escaped text
 */
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[char]);
}
