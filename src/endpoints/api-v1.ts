import { validateExtensionPromptInput } from '../headless/extension-prompt-input.js';
import { packageManagementEnabled, packageInventory, mutatePackages } from '../headless/package-management.js';
import { readExtensionUi, readExtensionSettings, saveExtensionSettings } from '../headless/extension-ui.js';
import { validateClientTools, assertClientToolsProfile, claimClientToolBatch, declineClientToolBatch, submitClientToolResults } from '../headless/client-tools.js';
import { removeGroupGenerationBatch } from '../headless/group-activation.js';
import { readCharacterChatSnapshot } from '../headless/chat-snapshot.js';
import { readGroupChatSnapshot } from '../headless/group-management.js';
import { checkProviderStatus, invalidateProviderStatus, readProviderStatus } from '../headless/provider-status.js';

import express from 'express';

import { API_V1_VERSION, ApiError, asyncHandler, ensureRequestId, requireObject, requireSafeId, sendApiError } from '../headless/contract.js';
import { deleteCharacter, exportCharacter, importCharacter, replaceCharacterAvatar, saveCharacter } from '../headless/character-management.js';
import { createGroupChat, deleteGroup, deleteGroupChat, deleteGroupMessage, editGroupMessage, getGroup, listGroupChats, listGroups, loadGroupCharacters, readGroupChat, renderGroupChat, resolveGroupChat, saveGroup, selectGroupSwipe } from '../headless/group-management.js';
import { activePreset, activatePreset, deletePreset, exportPreset, getPreset, listPresets, savePreset, setInstructEnabled } from '../headless/presets.js';
import { publicConfiguration } from '../headless/redaction.js';
import { readPromptManager, savePromptManager } from '../headless/prompt-manager.js';
import { chatSampling, readChatSampling, saveChatSampling, readGroupSampling, saveGroupSampling } from '../headless/chat-sampling.js';
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
import { runGroupGeneration } from '../headless/group-runtime.js';
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
            groups: true,
            groupManagement: true,
            groupChatPaging: true,
            groupChatSnapshot: true,
            groupChatRender: true,
            groupChatCreate: true,
            groupChatDelete: true,
            groupChatPreview: true,
            groupChatSampling: true,
            groupChatSwipe: true,
            groupChatMessageDelete: true,
            groupChatMessageEdit: true,
            characterCreate: true,
            characterEdit: true,
            characterDelete: true,
            characterImport: true,
            characterExport: true,
            characterAvatar: true,
            personas: true,
            promptManager: true,
            presets: true,
            textInstructSettings: true,
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
            chatSnapshot: true,
            chatSampling: true,
            chatRename: true,
            extensions: true,
            packageManagement: packageManagementEnabled(),
            extensionSettings: headlessPlugins,
            extensionUi: true,
            serverPlugins: !!getConfigValue('enableServerPlugins', false, 'boolean'),
            providerCredentials: true,
            providerModels: true,
            providerStatus: true,
            clientToolBatches: true,
            clientExtensionPrompts: true,
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
            groupNormal: true,
            groupRegenerate: true,
            groupContinue: true,
        },
        providers: {
            chatCompletionsOpenAI: true,
            chatCompletionsOpenAICompatible: false,
            claudeMessages: false,
            googleAiStudio: false,
            otherChatCompletionSources: false,
            novelai: false,
            kobold: false,
            textgen: false,
            textCompletionSources: [],
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
            instructMode: false,
            textCompletionRequests: false,
            groupChats: false,
            swipes: true,
            toolCalling: false,
            images: false,
            audio: false,
            tts: false,
            embeddings: false,
            vectors: false,
            serverPlugins: !!getConfigValue('enableServerPlugins', false, 'boolean'),
            headlessPlugins,
            headlessHooks: headlessPlugins ? Object.values(HEADLESS_HOOKS) : [],
            webviewPluginShell: true,
            legacyWebView: true,
        },
    });
});

router.get('/package-management', asyncHandler(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(await packageInventory(request, createSession(request)));
}));
router.post('/package-management/install', asyncHandler(async (request, response) => {
    response.json(await mutatePackages(request, createSession(request), true));
}));
router.post('/package-management/bulk', asyncHandler(async (request, response) => {
    response.json(await mutatePackages(request, createSession(request), false));
}));

router.get('/session', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.setHeader('Cache-Control', 'no-store');
    response.json({
        handle: session.handle,
        userName: session.userName,
        accountsEnabled: getConfigValue('enableUserAccounts', false, 'boolean'),
        admin: request.user?.profile?.admin === true,
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
            textgenerationwebui_settings: settings.textgenerationwebui_settings,
            world_info_settings: settings.world_info_settings,
            power_user: settings.power_user,
            extension_settings: settings.extension_settings,
        },
    });
}));

router.patch('/settings', asyncHandler(async (request, response) => {
    const session = createSession(request);
    invalidateProviderStatus(session);
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
router.get('/chats/:chatId/sampling', asyncHandler(async (request, response) => {
    response.json(readChatSampling(createSession(request), requireSafeId(request.query.characterId, 'characterId'), request.params.chatId));
}));
router.put('/chats/:chatId/sampling', asyncHandler(async (request, response) => {
    response.json(saveChatSampling(createSession(request), requireSafeId(request.query.characterId, 'characterId'), request.params.chatId, request.body));
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

router.put('/instruct-mode', asyncHandler(async (request, response) => {
    response.json(setInstructEnabled(createSession(request), requireObject(request.body, 'Instruct mode input')));
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

router.post('/provider-models', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const { listCustomModels } = await import('../headless/provider.js');
    response.json(await listCustomModels(session, request.body?.baseUrl));
}));

router.get('/provider-status', asyncHandler(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(await readProviderStatus(createSession(request)));
}));
router.post('/provider-status/check', asyncHandler(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const input = requireObject(request.body, 'connection check');
    if (Object.keys(input).length) throw new ApiError(400, 'validation', 'Connection checks use the saved provider configuration and accept no arguments.');
    response.json(await checkProviderStatus(createSession(request)));
}));

router.put('/provider-credentials', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const { SECRET_KEYS, writeSecret } = await import('./secrets.js');
    const provider = request.body?.provider;
    const apiKey = request.body?.apiKey;
    const key = credentialKey(provider, SECRET_KEYS);
    if (!key) throw new ApiError(400, 'validation', 'Choose openai or custom.');
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0 || apiKey.length > 4096) {
        throw new ApiError(400, 'validation', 'apiKey must be a non-empty string up to 4096 characters.');
    }
    invalidateProviderStatus(session);
    writeSecret(session.directories, key, apiKey.trim());
    response.json({ saved: true, provider });
}));

router.delete('/provider-credentials/:provider', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const { SECRET_KEYS, SecretManager } = await import('./secrets.js');
    const key = credentialKey(request.params.provider, SECRET_KEYS);
    if (!key) throw new ApiError(400, 'validation', 'Choose openai or custom.');
    const manager = new SecretManager(session.directories);
    invalidateProviderStatus(session);
    const entries = manager.getSecretState()[key];
    if (Array.isArray(entries)) {
        for (const entry of entries) manager.deleteSecret(key, entry.id);
    }
    response.json({ deleted: true, provider: request.params.provider });
}));

function credentialKey(provider: any, keys: any) {
    if (provider === 'openai') return keys.OPENAI;
    if (provider === 'custom') return keys.CUSTOM;
    return null;
}

// ---- extension settings (scoped write, never raw settings) ----

router.get('/extensions/:extensionId/settings', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.json(readExtensionSettings(session, request.params.extensionId));
}));

router.patch('/extensions/:extensionId/settings', asyncHandler(async (request, response) => {
    if (!areHeadlessPluginHooksEnabled()) {
        throw new ApiError(403, 'disabled', 'Headless plugins are disabled; extension settings are read-only.');
    }
    const session = createSession(request);
    response.json(saveExtensionSettings(session, request.params.extensionId, request.body, request.get('If-Match')));
}));

// ---- characters & chats ----

router.get('/characters', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.json(await listCharacters(session));
}));

router.get('/groups', asyncHandler(async (request, response) => {
    response.json(await listGroups(createSession(request)));
}));

router.post('/groups', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const input = requireObject(request.body, 'group input');
    response.status(201).json(saveGroup(session, { groupId: input.groupId, group: input.group }));
}));

router.get('/groups/:groupId', asyncHandler(async (request, response) => {
    response.json(await getGroup(createSession(request), request.params.groupId));
}));

router.put('/groups/:groupId', asyncHandler(async (request, response) => {
    const input = requireObject(request.body, 'group input');
    response.json(saveGroup(createSession(request), {
        groupId: request.params.groupId, group: input.group,
        expectedRevision: input.expectedRevision, create: false,
    }));
}));

router.delete('/groups/:groupId', asyncHandler(async (request, response) => {
    response.json(await deleteGroup(createSession(request), request.params.groupId,
        String(request.query.expectedRevision ?? ''), request.query.deleteChats === 'true'));
}));

router.get('/groups/:groupId/chats', asyncHandler(async (request, response) => {
    response.json(await listGroupChats(createSession(request), request.params.groupId));
}));

router.post('/groups/:groupId/chats', asyncHandler(async (request, response) => {
    const input = requireObject(request.body, 'group chat input');
    response.status(201).json(await createGroupChat(createSession(request), request.params.groupId, input.chatId, input.expectedRevision));
}));

router.get('/groups/:groupId/chats/:chatId', asyncHandler(async (request, response) => {
    response.json(await readGroupChat(createSession(request), request.params.groupId, request.params.chatId, {
        limit: request.query.limit, before: request.query.before, after: request.query.after,
    }));
}));

router.get('/groups/:groupId/chats/:chatId/snapshot', asyncHandler(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(await readGroupChatSnapshot(createSession(request), request.params.groupId, request.params.chatId));
}));

router.post('/groups/:groupId/chats/:chatId/render', asyncHandler(async (request, response) => {
    const input = requireObject(request.body, 'group display input');
    response.json(await renderGroupChat(createSession(request), request.params.groupId, request.params.chatId, {
        limit: input.limit, before: input.before, after: input.after, nativeContext: validateNativeMacroContext(input.nativeContext),
    }));
}));

router.delete('/groups/:groupId/chats/:chatId', asyncHandler(async (request, response) => {
    response.json(await deleteGroupChat(createSession(request), request.params.groupId, request.params.chatId, String(request.query.expectedRevision ?? '')));
}));

router.post('/groups/:groupId/chats/:chatId/swipe', asyncHandler(async (request, response) => {
    const input = requireObject(request.body, 'group swipe input');
    response.json(await selectGroupSwipe(createSession(request), request.params.groupId, request.params.chatId, input.index, input.swipeId, input.expectedMessage));
}));

router.post('/groups/:groupId/chats/:chatId/messages/delete', asyncHandler(async (request, response) => {
    const input = requireObject(request.body, 'group message deletion');
    response.json(await deleteGroupMessage(createSession(request), request.params.groupId, request.params.chatId, input.index, input.expectedMessage));
}));

router.post('/groups/:groupId/chats/:chatId/messages/edit', asyncHandler(async (request, response) => {
    const input = requireObject(request.body, 'group message edit');
    response.json(await editGroupMessage(createSession(request), request.params.groupId, request.params.chatId, input.index, input.expectedMessage, input.text, validateNativeMacroContext(input.nativeContext)));
}));

router.get('/groups/:groupId/chats/:chatId/sampling', asyncHandler(async (request, response) => {
    response.json(await readGroupSampling(createSession(request), request.params.groupId, request.params.chatId));
}));
router.put('/groups/:groupId/chats/:chatId/sampling', asyncHandler(async (request, response) => {
    response.json(await saveGroupSampling(createSession(request), request.params.groupId, request.params.chatId, request.body));
}));
router.post('/groups/:groupId/chats/:chatId/preview', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const input = validateGenerationInput({ ...requireObject(request.body, 'group preview input'), chatId: request.params.chatId });
    const { group, chat } = await resolveGroupChat(session, request.params.groupId, input.chatId);
    const characters = await loadGroupCharacters(session, group);
    const characterIndex = characters.findIndex(character => character.avatar === `${input.characterId}.png`);
    if (characterIndex < 0) throw new ApiError(404, 'not_found', 'Character is not a group member.');
    const character = characters[characterIndex];
    if (input.type === 'normal' && input.input) chat.push({ name: session.userName, is_user: true, mes: input.input });
    const lastMessage = chat.at(-1);
    if (['regenerate', 'continue'].includes(input.type) && (chat.length <= 1 || !lastMessage || lastMessage.is_user || lastMessage.is_system || typeof lastMessage.mes !== 'string')) throw new ApiError(409, 'conflict', 'The last message must be an assistant reply.');
    if (input.type === 'continue') {
        const last = chat.at(-1);
        if (last.is_system || (last.original_avatar ? last.original_avatar !== character.avatar : last.name !== character.name)) {
            throw new ApiError(409, 'conflict', 'The selected member did not write the last reply.');
        }
    }
    if (input.type === 'regenerate') removeGroupGenerationBatch(chat);
    const built = await buildPrompt(session, character.data, chat, {
        type: input.type === 'regenerate' ? 'normal' : input.type, input: input.type === 'regenerate' ? '' : input.input, overrides: { ...chatSampling(chat), ...input.overrides },
        characterId: input.characterId, chatId: input.chatId, nativeContext: input.nativeContext, extensionPrompts: input.extensionPrompts,
        groupContext: { group, characters, characterIndex }, preview: true,
        stageUserInput: input.type === 'normal' && Boolean(input.input),
    });
    response.json({ messages: built.messages, prompt: built.prompt, segments: built.segments, warnings: built.warnings, providerRequest: publicConfiguration(built.providerRequest) });
}));

router.post('/groups/:groupId/chats/:chatId/generations', asyncHandler(async (request, response) => {
    const body = requireObject(request.body, 'group generation input');
    const groupId = requireSafeId(request.params.groupId, 'groupId');
    const input = validateGenerationInput({ ...body, characterId: groupId, chatId: request.params.chatId });
    if (input.tools?.length) throw new ApiError(422, 'unsupported', 'Client tool execution for groups is not configured.');
    if (input.type === 'quiet') throw new ApiError(422, 'unsupported', 'Quiet group generation is not supported.');
    const { prepareProviderSession } = await import('../headless/provider.js');
    const session = await prepareProviderSession(request);
    await resolveGroupChat(session, groupId, input.chatId);
    const created = createGeneration({
        handle: session.handle, clientRequestId: body.clientRequestId, characterId: groupId,
        chatId: input.chatId, type: input.type, targetKind: 'group', requestIdentity: input,
        directories: session.directories,
    });
    if (!created.existing) {
        const detachedRequest = { user: request.user, session: request.session, ip: request.ip, headers: request.headers };
        void runGroupGeneration(detachedRequest, session, created.record, { ...input, groupId });
    }
    response.status(202).json({
        requestId: created.record.requestId, status: created.record.status, seq: created.record.seq,
        idempotent: created.existing, ...generationUrls(created.record.requestId),
    });
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

router.put('/characters/:characterId/avatar', asyncHandler(async (request, response) => {
    const input = requireObject(request.body, 'character avatar input');
    response.json(await replaceCharacterAvatar(createSession(request), request.params.characterId, input.expectedRevision, input.dataBase64));
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
    response.json(selectPersona(createSession(request), request.params.personaId, String(input.expectedRevision ?? '')));
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

router.get('/chats/:chatId/snapshot', asyncHandler(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const characterId = typeof request.query.characterId === 'string' ? request.query.characterId : '';
    response.json(readCharacterChatSnapshot(createSession(request), characterId, request.params.chatId));
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
    assertClientToolsProfile(session, input);
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
    const lastMessage = chat.at(-1);
    if (['regenerate', 'continue'].includes(input.type) && (chat.length <= 1 || !lastMessage || lastMessage.is_user || lastMessage.is_system || typeof lastMessage.mes !== 'string')) throw new ApiError(409, 'conflict', 'The last message must be an assistant reply.');
    const macroChat = input.type === 'regenerate' ? [...chat] : null;
    if (input.type === 'regenerate' && chat.length > 1 && !lastMessage?.is_user) chat.pop();
    const built = await buildPrompt(session, character.data, chat, {
        type: input.type, input: input.input, overrides: { ...chatSampling(chat), ...input.overrides },
        characterId: input.characterId, chatId: input.chatId, nativeContext: input.nativeContext, extensionPrompts: input.extensionPrompts, preview: true,
        macroChat, stageUserInput: input.type === 'normal' && Boolean(input.input),
    });
    if (input.tools?.length) {
        built.providerRequest.tools = input.tools;
        built.providerRequest.tool_choice = 'auto';
    }
    response.json({
        messages: built.messages,
        prompt: built.prompt,
        segments: built.segments,
        warnings: built.warnings,
        providerRequest: publicConfiguration(built.providerRequest),
    });
}));

router.post('/generations', asyncHandler(async (request, response) => {
    const input = validateGenerationInput(request.body);
    const { prepareProviderSession } = await import('../headless/provider.js');
    const session = await prepareProviderSession(request);
    assertClientToolsProfile(session, input);
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
        void runGeneration(detachedRequest as unknown as import('express').Request, session, created.record, input);
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
        targetKind: request.query.targetKind === undefined ? 'character' : String(request.query.targetKind),
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
        requireSafeId(request.body?.characterId, 'characterId'), requireSafeId(request.body?.chatId, 'chatId'),
        request.body?.targetKind === undefined ? 'character' : request.body.targetKind));
}));
router.post('/generations/:requestId/acknowledge', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.json(acknowledgeGeneration(getGeneration(request.params.requestId, session.handle, session.directories), request.body?.expectedSeq));
}));

router.post('/generations/:requestId/tool-batches/:batchId/:action', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const record = getGeneration(request.params.requestId, session.handle, session.directories);
    const actions: Record<string, any> = { claim: claimClientToolBatch, decline: declineClientToolBatch, results: submitClientToolResults };
    if (!Object.hasOwn(actions, request.params.action)) throw new ApiError(404, 'not_found', 'Unknown tool action.');
    response.json(actions[request.params.action](record, request.params.batchId, request.body));
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

// ---- isolated extension UI asset snapshot (no static SPA routes) ----
router.get('/extensions/:extensionId/ui', asyncHandler(async (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json(await readExtensionUi(createSession(request), request.params.extensionId));
}));

// The old same-origin executable shell exposed the host origin to extension code.
router.get('/extensions/*/shell', asyncHandler(async () => {
    throw new ApiError(410, 'unsupported', 'Use the isolated client extension host and the JSON UI snapshot endpoint.');
}));

router.use((error: any, request: any, response: any, _next: any) => sendApiError(response, ensureRequestId(request), error));

/**
 * Validates a generation request.
 * @param {any} body Request body
 * @param {object} options Validation options
 * @param {boolean} options.allowUnsupportedTypes Whether regenerate/continue are accepted
 * @returns {{characterId: string, chatId: string, type: string, input: string, stream: boolean, overrides: Record<string, any>}} Validated input
 */
function validateGenerationInput(body: any) {
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
        ...(body.extensionPrompts !== undefined ? { extensionPrompts: validateExtensionPromptInput(body.extensionPrompts) } : {}),
        ...(body.tools !== undefined ? { tools: validateClientTools(body.tools) } : {}),
    };
}

/** Only device/UI facts are accepted; scripts, settings and extension grants are server-owned. */
function validateNativeMacroContext(value: any) {
    if (value == null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'validation', 'nativeContext must be an object.');
    const allowed = new Set(['input', 'firstDisplayedMessageId', 'isMobile', 'locale', 'timeZone', 'lastGenerationType']);
    if (Object.keys(value).some(key => !allowed.has(key))) throw new ApiError(400, 'validation', 'Unknown nativeContext field.');
    const result: Record<string, any> = {};
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
