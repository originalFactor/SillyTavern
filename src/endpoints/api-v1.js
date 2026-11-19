import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { API_V1_VERSION, ApiError, asyncHandler, ensureRequestId, requireSafeId, sendApiError } from '../headless/contract.js';
import {
    cancel,
    createGeneration,
    generationUrls,
    getGeneration,
    isTerminal,
    snapshot,
    subscribe,
} from '../headless/generation-store.js';
import { buildPrompt, listExtensions } from '../headless/prompt.js';
import { areHeadlessPluginHooksEnabled, HEADLESS_HOOKS } from '../headless/plugin-runtime.js';
import { runGeneration } from '../headless/runtime.js';
import {
    createChat,
    createSession,
    deleteChat,
    isApiV1Enabled,
    listCharacters,
    listChats,
    mutateChat,
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
        auth: { cookieSession: true, csrf: true, bearerToken: false },
        resources: {
            session: true,
            settingsRead: true,
            settingsPatch: true,
            characters: true,
            chats: true,
            chatCreate: true,
            chatDelete: true,
            chatMutate: true,
            chatPaging: true,
            chatRename: false,
            extensions: true,
            extensionSettings: headlessPlugins,
            serverPlugins: !!getConfigValue('enableServerPlugins', false, 'boolean'),
        },
        generation: {
            preview: true,
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
            worldInfo: true,
            globalRegex: true,
            scopedRegex: false,
            promptManagerPresets: false,
            instructMode: false,
            groupChats: false,
            swipes: false,
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
    const settings = readSettings(session.directories);
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
    response.json({ raw: settings });
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

router.get('/characters/:characterId', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const character = await readCharacter(session, request.params.characterId);
    response.json(character);
}));

router.get('/characters/:characterId/chats', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.json(await listChats(session, request.params.characterId));
}));

router.post('/characters/:characterId/chats', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const chatId = requireSafeId(request.body?.chatId, 'chatId');
    const firstMessage = typeof request.body?.firstMessage === 'string' ? request.body.firstMessage.slice(0, 64 * 1024) : '';
    const character = await readCharacter(session, request.params.characterId);
    const greeting = firstMessage || String(character.data.first_mes ?? '');
    const created = createChat(session, request.params.characterId, chatId, greeting);
    response.status(201).json(created);
}));

router.get('/chats/:chatId', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const characterId = typeof request.query.characterId === 'string' ? request.query.characterId : '';
    requireSafeId(characterId, 'characterId');
    const chatPath = resolveChatPath(session, characterId, request.params.chatId);
    const page = readChatPage(chatPath, {
        limit: request.query.limit,
        before: request.query.before,
        after: request.query.after,
    });
    response.json({ characterId, chatId: request.params.chatId, ...page });
}));

router.post('/chats/:chatId/messages', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const characterId = typeof request.body?.characterId === 'string' ? request.body.characterId : '';
    requireSafeId(characterId, 'characterId');
    const chatPath = resolveChatPath(session, characterId, request.params.chatId);
    const action = String(request.body?.action ?? 'append');
    const index = await mutateChat(chatPath, {
        action,
        message: request.body?.message,
        index: request.body?.index,
    });
    response.status(action === 'append' ? 201 : 200).json({ chatId: request.params.chatId, action, index });
}));

router.delete('/chats/:chatId', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const characterId = typeof request.query.characterId === 'string' ? request.query.characterId : '';
    requireSafeId(characterId, 'characterId');
    if (!deleteChat(session, characterId, request.params.chatId)) {
        throw new ApiError(404, 'not_found', 'Chat not found.');
    }
    response.json({ deleted: true, chatId: request.params.chatId, characterId });
}));

router.get('/extensions', asyncHandler(async (request, response) => {
    const session = createSession(request);
    response.json(listExtensions(session));
}));

// ---- generations ----

router.post('/generations/preview', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const input = validateGenerationInput(request.body, { allowUnsupportedTypes: false });
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
    const built = buildPrompt(session, character.data, chat, { type: input.type, input: input.input, overrides: input.overrides });
    response.json({
        messages: built.messages,
        segments: built.segments,
        warnings: built.warnings,
        providerRequest: built.providerRequest,
    });
}));

router.post('/generations', asyncHandler(async (request, response) => {
    const session = createSession(request);
    const input = validateGenerationInput(request.body, { allowUnsupportedTypes: true });
    const created = createGeneration({
        handle: session.handle,
        clientRequestId: request.body.clientRequestId,
        characterId: input.characterId,
        chatId: input.chatId,
        type: input.type,
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
    console.info('[api-v1] generation_accepted', JSON.stringify({ requestId: created.record.requestId, clientRequestId: created.record.clientRequestId }));
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
function validateGenerationInput(body, { allowUnsupportedTypes }) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError(400, 'validation', 'Request body must be a JSON object.');
    }
    const type = String(body.type ?? 'normal');
    if (!['normal', 'quiet', 'regenerate', 'continue'].includes(type)) {
        throw new ApiError(400, 'validation', `Unknown generation type "${type}".`);
    }
    if (!allowUnsupportedTypes && ['regenerate', 'continue'].includes(type)) {
        throw new ApiError(422, 'unsupported', `Generation type "${type}" is not supported by preview.`);
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
    };
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
