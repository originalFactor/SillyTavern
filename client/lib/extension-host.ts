import { EXTENSION_HOST_MODULES } from "../../src/headless/extension-host-contract";
import { installExtensionRuntime } from "./extension-runtime/core";
import { event_types } from "./extension-runtime/events";
import { installExtensionCompatibility } from "./extension-runtime/compatibility";
import { installExtensionOpenAI } from "./extension-runtime/openai";
import { installExtensionPresets } from "./extension-runtime/presets";
import { installExtensionRegex } from "./extension-runtime/regex";
import { installExtensionScript } from "./extension-runtime/script";
import { installExtensionCleanup } from "./extension-runtime/cleanup";
import { PRESET_SETTING_KEYS } from "../../src/headless/preset-mapping";
import type { ExtensionGenerationState } from "./extension-chat";

export type ExtensionBundle = {
  extensionId: string; name: string; namespace: string; base: string; entries: string[];
  modules: Record<string, string>; templates: Record<string, string>; css: string[]; html: string;
  libraries: { jquery: string; handlebars: string; purify: string; lodash?: string; moment?: string; bowser?: string }; activate: string | null;
};

// This function is serialized into an opaque-origin sandbox. It must not close over host state.
function frameRuntime(payload: { bundle: ExtensionBundle; settings: unknown; channel: string; readOnly: boolean; locale: string; events: Record<string, string>; hostModules: readonly string[]; presetSettingKeys: Record<string, string>; generationState: ExtensionGenerationState; promptInjectionEnabled: boolean }, install: typeof installExtensionRuntime, compatibility: typeof installExtensionCompatibility, openai: typeof installExtensionOpenAI, presets: typeof installExtensionPresets, regex: typeof installExtensionRegex, script: typeof installExtensionScript, cleanupRuntime: typeof installExtensionCleanup) {
  const { bundle, channel } = payload;
  const w = window as any;
  const send = (type: string, data: unknown = {}) => parent.postMessage({ channel, type, ...data as object }, "*");
  const diagnostic = (error: unknown) => send("diagnostic", { message: error instanceof Error ? error.message : String(error) });
  window.addEventListener("error", event => diagnostic(event.error ?? event.message));
  window.addEventListener("unhandledrejection", event => { event.preventDefault(); diagnostic(event.reason); });
  const unsupported = (name: string) => { throw new Error(`Unsupported extension host API: ${name}`); };
  const clean = (html: string) => w.DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "iframe", "form", "meta", "base", "link"], FORBID_ATTR: ["src", "srcset", "action", "formaction", "target"] });
  document.addEventListener("click", event => { if ((event.target as Element)?.closest("a")) event.preventDefault(); }, true);
  document.addEventListener("submit", event => event.preventDefault(), true);
  const clone = (value: unknown) => JSON.parse(JSON.stringify(value));
  const extensionSettings = Object.assign(Object.create(null), { [bundle.namespace]: clone(payload.settings) });
  let baseline = clone(payload.settings);
  let timer: ReturnType<typeof setTimeout>;
  let serial = Promise.resolve();
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let receiveProviderStatus: ((value: unknown) => void) | undefined;
  let collectPrompts: (() => Promise<unknown>) | undefined;
  let collectingPrompts = false;
  let receiveGenerationState: ((value: unknown) => void) | undefined;
  window.addEventListener("message", event => {
    if (event.source !== parent || event.data?.channel !== channel) return;
    if (event.data?.type === "provider-status") { receiveProviderStatus?.(event.data.value); return; }
    if (event.data?.type === "generation-state") { receiveGenerationState?.(event.data.value); return; }
    if (event.data?.type === "collect-prompts") {
      const id = event.data.id;
      if (!Number.isSafeInteger(id) || collectingPrompts || !collectPrompts) return;
      collectingPrompts = true;
      void (async () => {
        try { send("prompt-snapshot", { id, value: await collectPrompts!() }); }
        catch (error) { send("prompt-snapshot", { id, error: error instanceof Error ? error.message : "Extension prompt capture failed." }); }
        finally { collectingPrompts = false; }
      })();
      return;
    }
    if (event.data?.type !== "result") return;
    const request = pending.get(event.data.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(event.data.id);
    event.data.error ? request.reject(new Error(event.data.error)) : request.resolve(event.data.value);
  });
  const request = (type: string, data: object) => new Promise<any>((resolve, reject) => {
    if (pending.size >= 16) return reject(new Error("Too many pending extension host requests."));
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Extension host request timed out. Inspect server state before retrying a write.")); }, 30000);
    pending.set(id, { resolve, reject, timer: timeout }); send(type, { id, ...data });
  });
  const save = () => {
    clearTimeout(timer);
    send("dirty", { dirty: true });
    // Serialize saves, but never retry a failed mutation or continue a failed queue.
    serial = serial.then(async () => {
      if (payload.readOnly) unsupported("settings writes (read-only)");
      const snapshot = clone(extensionSettings[bundle.namespace]);
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) unsupported("non-object settings namespace");
      if (Object.keys(baseline).some(key => !Object.hasOwn(snapshot, key))) unsupported("settings key deletion");
      const patch = Object.fromEntries(Object.entries(snapshot).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(baseline[key])));
      if (Object.keys(patch).length) {
        const result = await request("save", { patch });
        baseline = clone(result.settings);
      }
      send("dirty", { dirty: JSON.stringify(extensionSettings[bundle.namespace]) !== JSON.stringify(baseline) });
    });
    serial.catch(diagnostic);
    return serial;
  };
  const saveDebounced = () => { send("dirty", { dirty: true }); clearTimeout(timer); timer = setTimeout(() => { void save(); }, 300); };
  const runtime = install(w, { unsupported, clean, diagnostic }, payload.events, payload.locale);
  const { eventSource, events, utils, i18n, popup } = runtime;
  const render = (extension: string, template: string, data: object = {}, sanitize = true, localize = true) => {
    if (![bundle.name, bundle.extensionId, `third-party/${bundle.name}`].includes(extension)) unsupported(`cross-extension template: ${extension}`);
    const file = template.endsWith(".html") ? template : `${template}.html`;
    if (!Object.hasOwn(bundle.templates, file)) unsupported(`template not packaged: ${file}`);
    const rendered = w.Handlebars.compile(bundle.templates[file])(data);
    // The frame CSP still applies when upstream callers explicitly opt out of sanitizing.
    const html = sanitize ? clean(rendered) : rendered;
    return localize ? i18n.applyLocale(html) : html;
  };
  const context: any = {
    extensionSettings, extension_settings: extensionSettings, extensionId: bundle.extensionId,
    eventSource, eventTypes: events, event_types: events,
    saveSettingsDebounced: saveDebounced, saveSettings: save,
    renderExtensionTemplate: render, renderExtensionTemplateAsync: async (...args: Parameters<typeof render>) => render(...args),
    // In upstream these edit character cards, not extension settings.
    writeExtensionField: () => unsupported("writeExtensionField (character mutation)"),
    writeExtensionFieldBulk: () => unsupported("writeExtensionFieldBulk (character mutation)"),
    uuidv4: utils.uuidv4,
    ...i18n, ...popup,
  };
  // Missing fields stay undefined for upstream-style feature detection. Known
  // privileged methods reject explicitly when called, rather than appearing usable.
  for (const name of ["getRequestHeaders", "generate", "generateQuietPrompt", "generateRaw", "saveChat", "saveMetadata", "saveMetadataDebounced", "writeExtensionField", "writeExtensionFieldBulk", "executeSlashCommands", "executeSlashCommandsWithOptions", "registerFunctionTool"]) {
    if (!Object.hasOwn(context, name)) context[name] = () => unsupported(name);
  }
  const proxy = context;
  w.SillyTavern = { getContext: () => proxy, getContextAsync: async () => proxy };
  w.extension_settings = extensionSettings;
  w.saveSettingsDebounced = saveDebounced;
  w.toastr = { error: diagnostic, warning: diagnostic, info: diagnostic, success: () => {} };
  const blocked = (name: string) => (..._args: any[]) => unsupported(name);
  const bindings = new Map<string, ((value: any) => void)[]>();
  const publish = (file: string, name: string, value: any) => {
    for (const update of bindings.get(`${file}:${name}`) ?? []) update(value);
    if (file === "/scripts/personas.js" && name === "user_avatar") {
      for (const update of bindings.get(`/script.js:${name}`) ?? []) update(value);
    }
  };
  let extensionCatalog: { names: string[]; types: Record<string, string> } | undefined;
  const modules: Record<string, Record<string, any>> = {
    ...compatibility(w, { unsupported, eventSource, events, publish, getContext: () => proxy, getChatSnapshot: () => modules["/script.js"].getChatSnapshot(), extensionName: bundle.name, thirdParty: bundle.extensionId.includes("/"), request: (operation: string, args: object) => request("resource", { operation, args }) }),
    ...openai(w, { unsupported, isDataURL: utils.isDataURL, countText: (text: string) => modules["/scripts/tokenizers.js"].getTokenCount(text), request: (operation: string, args: object) => request("resource", { operation, args }) }),
    ...presets(w, { unsupported, settingKeys: payload.presetSettingKeys, request: (operation: string, args: object) => request("resource", { operation, args }) }),
    ...regex(w, { unsupported, regexFromString: utils.regexFromString, getContext: () => proxy, hasNativeChat: () => modules["/script.js"].getChatSnapshot().bound, request: (operation: string, args: object) => request("resource", { operation, args }) }),
    "/scripts/st-context.js": { getContext: () => proxy, getContextAsync: async () => proxy, default: () => proxy },
    "/scripts/extensions.js": {
      getContext: () => proxy, extension_settings: extensionSettings,
      get extensionNames() { if (!extensionCatalog) return unsupported("extensionNames (catalog snapshot is not loaded)"); return [...extensionCatalog.names]; },
      get extensionTypes() { if (!extensionCatalog) return unsupported("extensionTypes (catalog snapshot is not loaded)"); return { ...extensionCatalog.types }; },
      renderExtensionTemplate: render, renderExtensionTemplateAsync: context.renderExtensionTemplateAsync,
      writeExtensionField: context.writeExtensionField, writeExtensionFieldBulk: context.writeExtensionFieldBulk,
      saveMetadataDebounced: context.saveMetadataDebounced,
      // Retain the earlier host aliases for installed settings extensions.
      saveSettingsDebounced: saveDebounced, saveSettings: save,
    },
    "/script.js": {
      eventSource, event_types: events, saveSettingsDebounced: saveDebounced, saveSettings: save,
      getRequestHeaders: blocked("getRequestHeaders"), Generate: blocked("Generate"),
      generate: blocked("generate"), generateQuietPrompt: blocked("generateQuietPrompt"),
    },
    "/lib.js": { DOMPurify: w.DOMPurify, Handlebars: w.Handlebars, lodash: w._, moment: w.moment, Bowser: w.bowser,
      default: { DOMPurify: w.DOMPurify, Handlebars: w.Handlebars, lodash: w._, moment: w.moment, Bowser: w.bowser } },
    "/lib/eventemitter.js": { EventEmitter: runtime.EventEmitter },
    "/scripts/events.js": { eventSource, event_types: events },
    "/scripts/event-types.js": { event_types: events },
    "/scripts/utils.js": utils,
    "/scripts/popup.js": popup,
    "/scripts/i18n.js": i18n,
    "/scripts/templates.js": {
      renderTemplate: (name: string, data: object, sanitize = true, localize = true, fullPath = false) => {
        if (!fullPath) return unsupported(`host template: ${name}`);
        const url = new URL(name, bundle.base);
        if (!url.href.startsWith(bundle.base)) return unsupported(`cross-extension template: ${name}`);
        return render(bundle.name, decodeURIComponent(url.href.slice(bundle.base.length)), data, sanitize, localize);
      },
      renderTemplateAsync: async (...args: any[]) => modules["/scripts/templates.js"].renderTemplate(...args),
    },
  };
  // Preserve accessor descriptors: spreading the script adapter would eagerly
  // read native state before its dependencies have initialized.
  const cleanup = cleanupRuntime(w, {
    unsupported, getContext: () => proxy, reasoning: modules["/scripts/reasoning.js"], regex: modules["/scripts/extensions/regex/engine.js"],
    hasNativeChat: () => modules["/script.js"].getChatSnapshot().bound,
    request: (operation: string, args: object) => request("resource", { operation, args }),
  });
  Object.assign(modules["/scripts/power-user.js"], { collapseNewlines: cleanup.collapseNewlines, fixMarkdown: cleanup.fixMarkdown });
  Object.assign(utils, { trimToEndSentence: cleanup.trimToEndSentence });
  Object.defineProperties(modules["/script.js"], Object.getOwnPropertyDescriptors(script(w, {
    utils, unsupported, cleanup, eventSource, events, publish, promptInjectionEnabled: payload.promptInjectionEnabled, getContext: () => proxy,
    request: (operation: string, args: object) => request("resource", { operation, args }),
    personas: modules["/scripts/personas.js"], reasoning: modules["/scripts/reasoning.js"], openai: modules["/scripts/openai.js"],
  })));
  collectPrompts = () => modules["/script.js"].collectExtensionPrompts();
  receiveProviderStatus = value => modules["/script.js"].updateOnlineStatus(value);
  receiveGenerationState = value => modules["/script.js"].updateGenerationState(value);
  receiveGenerationState(payload.generationState);
  Object.defineProperty(modules["/scripts/extensions.js"], "initialize", { value: async () => { extensionCatalog = await request("resource", { operation: "extensions.catalog", args: {} }); } });
  for (const file of ["/scripts/PromptManager.js", "/scripts/slash-commands/SlashCommand.js", "/scripts/slash-commands/SlashCommandArgument.js", "/scripts/slash-commands/SlashCommandEnumValue.js", "/scripts/slash-commands/SlashCommandParser.js"]) Object.assign(context, modules[file]);
  context.executeSlashCommandsWithOptions = modules["/scripts/slash-commands.js"].executeSlashCommandsWithOptions;
  context.getTokenCount = modules["/scripts/tokenizers.js"].getTokenCount;
  context.getTokenCountAsync = modules["/scripts/tokenizers.js"].getTokenCountAsync;
  Object.defineProperty(context, "userAvatar", { get: () => modules["/scripts/personas.js"].user_avatar });
  Object.defineProperty(context, "mainApi", { get: () => modules["/script.js"].main_api });
  context.getCurrentChatId = modules["/script.js"].getCurrentChatId;
  Object.defineProperties(context, {
    characters: { get: () => modules["/script.js"].characters },
    characterId: { get: () => modules["/script.js"].this_chid },
    groupId: { get: () => modules["/script.js"].selectionGroupId },
    chatId: { get: () => modules["/script.js"].getCurrentChatId() },
    chat: { get: () => modules["/script.js"].chat },
    chatMetadata: { get: () => modules["/script.js"].chat_metadata },
    name1: { get: () => modules["/script.js"].name1 },
    name2: { get: () => modules["/script.js"].name2 },
    extensionPrompts: { get: () => modules["/script.js"].extension_prompts },
    onlineStatus: { get: () => modules["/script.js"].online_status },
  });
  context.printMessages = modules["/script.js"].printMessages;
  context.isGenerating = modules["/script.js"].isGenerating;
  for (const name of ["saveChatConditional", "saveMetadata", "activateSendButtons", "deactivateSendButtons", "saveCharacterDebounced", "substituteParams", "substituteParamsExtended", "stopGeneration", "getCharacters", "getThumbnailUrl", "messageFormatting", "addOneMessage", "setExtensionPrompt", "selectCharacterById", "reloadCurrentChat", "clearChat", "unshallowCharacter", "getCharacterCardFields"]) context[name] = modules["/script.js"][name];
  // Upstream's context.saveChat is the conditional dispatcher, not the raw
  // character-only saveChat export (which rejects group chats upstream).
  context.saveChat = modules["/script.js"].saveChatConditional;
  w.__extensionHost = { context: proxy, modules, render, unsupported, subscribe: (file: string, name: string, update: (value: any) => void) => {
    const key = `${file}:${name}`; const list = bindings.get(key) ?? []; list.push(update); bindings.set(key, list);
  } };
  const urls: string[] = [];
  const blob = (source: string) => { const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" })); urls.push(url); return url; };
  const imports: Record<string, string> = {};
  for (const file of payload.hostModules) {
    const exports = Object.keys(modules[file]).map(name => name === "default" ? "export default m.default;" : Object.getOwnPropertyDescriptor(modules[file], name)?.get ? `export let ${name}=m.${name}; window.__extensionHost.subscribe(${JSON.stringify(file)},${JSON.stringify(name)},value=>${name}=value);` : `export const ${name}=m.${name};`).join("\n");
    imports[`https://extension.invalid${file}`] = blob(`const m=window.__extensionHost.modules[${JSON.stringify(file)}];\n${exports}`);
  }
  for (const [url, source] of Object.entries(bundle.modules)) imports[url] = blob(source);
  const map = document.createElement("script"); map.type = "importmap"; map.textContent = JSON.stringify({ imports }); document.head.append(map);
  const root = document.getElementById("extensions_settings")!;
  const container = document.createElement("div"); container.id = `${bundle.name.replace(/[^\w-]/g, "_")}_container`; root.append(container);
  if (bundle.html) container.innerHTML = clean(bundle.html);
  const style = document.createElement("style"); style.textContent = bundle.css.join("\n"); document.head.append(style);
  void (async () => {
    const sources = Object.values(bundle.modules);
    const required = new Set(Object.keys(modules).filter(file => sources.some(source => source.includes(`https://extension.invalid${file}`))));
    if (required.has("/script.js")) required.add("/scripts/extensions/regex/engine.js");
    if (["/script.js", "/scripts/st-context.js", "/scripts/extensions.js", "/scripts/macros.js"].some(file => required.has(file))) {
      required.add("/script.js");
      required.add("/scripts/extensions/regex/engine.js");
      required.add("/scripts/personas.js");
      required.add("/scripts/reasoning.js");
      required.add("/scripts/openai.js");
    }
    const initializers = Object.entries(modules).filter(([file, module]) => required.has(file) && typeof module.initialize === "function");
    // The parent accepts four resource operations at once. More adapters must
    // not turn successful startup into a fifth concurrent request rejection.
    for (let offset = 0; offset < initializers.length; offset += 4) await Promise.all(initializers.slice(offset, offset + 4).map(([, module]) => module.initialize()));
    let activated = !bundle.activate;
    for (const entry of bundle.entries) {
      const loaded = await import(/* webpackIgnore: true */ entry);
      if (bundle.activate && typeof loaded[bundle.activate] === "function") { await loaded[bundle.activate](); activated = true; }
    }
    if (!activated) unsupported(`activate hook: ${bundle.activate}`);
    // Legacy extensions initialize through jQuery ready rather than exported hooks.
    await new Promise<void>(resolve => w.$(() => resolve()));
    await eventSource.emit(events.EXTENSION_SETTINGS_LOADED);
    await eventSource.emit(events.APP_INITIALIZED);
    await eventSource.emit(events.APP_READY);
    send("ready");
  })().catch(diagnostic);
  window.addEventListener("pagehide", () => { clearTimeout(timer); for (const url of urls) URL.revokeObjectURL(url); });
}

export function extensionFrameDocument(bundle: ExtensionBundle, settings: unknown, channel: string, readOnly: boolean, locale = "en-US", generationState: ExtensionGenerationState = { isSendPress: false, isGroupGenerating: false }, promptInjectionEnabled = false) {
  const script = (source: string) => `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`;
  const payload = JSON.stringify({ bundle, settings, channel, readOnly, locale, generationState, promptInjectionEnabled, events: event_types, hostModules: EXTENSION_HOST_MODULES, presetSettingKeys: PRESET_SETTING_KEYS }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html{color-scheme:dark}body{margin:16px;background:#0a0a0a;color:#ededed;font:14px system-ui;line-height:1.5}input,select,textarea,button{font:inherit;color:inherit;background:#171717;border:1px solid #555;padding:6px;max-width:100%;box-sizing:border-box}textarea{width:100%}.flex-container{display:flex;gap:8px;flex-wrap:wrap}.flexFlowColumn{flex-direction:column}.displayNone{display:none}.inline-drawer-content{padding:8px 0}label{display:block}button{cursor:pointer}:focus-visible{outline:2px solid #a1a1a1}</style></head><body><main id="extensions_settings"><div id="extensions_settings2"></div></main>${script(bundle.libraries.jquery)}${script(bundle.libraries.handlebars)}${script(bundle.libraries.purify)}${bundle.libraries.lodash ? script(bundle.libraries.lodash) : ""}${bundle.libraries.moment ? script(bundle.libraries.moment) : ""}${bundle.libraries.bowser ? script(bundle.libraries.bowser) : ""}${script(`(${frameRuntime.toString()})(${payload}, ${installExtensionRuntime.toString()}, ${installExtensionCompatibility.toString()}, ${installExtensionOpenAI.toString()}, ${installExtensionPresets.toString()}, ${installExtensionRegex.toString()}, ${installExtensionScript.toString()}, ${installExtensionCleanup.toString()});`)}</body></html>`;
}

