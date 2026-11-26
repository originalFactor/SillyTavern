import type { ApiRequestInit } from "../api";

export type ExtensionChatSelection = { kind: "character" | "group"; id: string; chatId: string };

// Parent-only adapter. Extension messages select an operation, never an API
// path, URL, method, header or revision. Authentication stays in the bound API.
export function createExtensionResourceReader(api: <T>(path: string, init?: ApiRequestInit) => Promise<T>, signal?: AbortSignal, options: { selection?: ExtensionChatSelection; allowPersonaSelection?: boolean; isCurrent?: () => boolean; printMessages?: (signal?: AbortSignal) => Promise<void>; setSendButtonsEnabled?: (enabled: boolean, signal: AbortSignal) => void } = {}) {
  const checkCurrent = () => { if (signal?.aborted || (options.isCurrent && !options.isCurrent())) throw Error("Extension session was replaced or aborted. Reload before continuing."); };
  // Capture parent-owned identity. A frame can neither supply nor retarget it.
  const selection = options.selection && { ...options.selection };
  let personaRevision: string | undefined;
  let personaIds = new Set<string>();
  let personaReads = 0;
  let selecting = false, selectionFailed = false;
  const safeId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\\/\x00-\x1f\x7f]/.test(value) && ![".", ".."].includes(value);
  let chatSnapshot: Promise<any> | undefined;
  const readChatSnapshot = async () => {
    // No selected native conversation means the source's initial no-chat
    // state. Never replace a missing, failed or oversized selected chat by it.
    if (!selection) return { bound: false, chat: [], chatMetadata: {} };
    if (!["character", "group"].includes(selection.kind) || !safeId(selection.id) || !safeId(selection.chatId)) throw Error("Invalid native conversation selection.");
    const path = selection.kind === "group" ? `/groups/${encodeURIComponent(selection.id)}/chats/${encodeURIComponent(selection.chatId)}/snapshot` : `/chats/${encodeURIComponent(selection.chatId)}/snapshot?characterId=${encodeURIComponent(selection.id)}`;
    checkCurrent();
    const result = await api<any>(path, { signal });
    checkCurrent();
    const object = (value: any) => value && typeof value === "object" && !Array.isArray(value);
    if (!object(result) || new TextEncoder().encode(JSON.stringify(result)).length > 8_392_704 || result.chatId !== selection.chatId || result[selection.kind === "group" ? "groupId" : "characterId"] !== selection.id || typeof result.revision !== "string" || !/^[a-f0-9]{64}$/.test(result.revision) || typeof result.headerPresent !== "boolean" || (selection.kind === "character" && !result.headerPresent) || !object(result.chatMetadata) || !Array.isArray(result.messages) || result.messages.length > 10000 || result.messages.some((row: any) => !object(row) || Object.hasOwn(row, "chat_metadata"))) throw Error("Invalid or oversized complete chat snapshot. Update the server and reload the extension.");
    return { bound: true, chat: result.messages, chatMetadata: result.chatMetadata };
  };
  let characterSnapshot: Promise<any> | undefined;
  const readCharacters = async () => {
    const object = (value: any) => value && typeof value === "object" && !Array.isArray(value);
    const bytes = (value: any) => new TextEncoder().encode(JSON.stringify(value)).length;
    const get = async (path: string) => { checkCurrent(); const result = await api<any>(path, { signal }); checkCurrent(); return result; };
    if (selection && (!["character", "group"].includes(selection.kind) || !safeId(selection.id) || !safeId(selection.chatId))) throw Error("Invalid native conversation selection.");
    const catalog = (value: any) => {
      if (!Array.isArray(value) || value.length > 512 || bytes(value) > 1_048_576) throw Error("Invalid or oversized character catalog.");
      const ids = new Set<string>();
      return value.map(row => {
        if (!object(row) || !safeId(row.id) || ids.has(row.id) || row.avatar !== `${row.id}.png` || typeof row.name !== "string" || row.name.length > 65_536 || typeof row.revision !== "string" || !row.revision || row.revision.length > 256) throw Error("Invalid character catalog entry or missing revision.");
        ids.add(row.id);
        return { id: row.id, avatar: row.avatar, name: row.name, revision: row.revision };
      });
    };
    const listing = catalog(await get("/characters"));
    const index = selection?.kind === "character" ? listing.findIndex(row => row.id === selection.id) : undefined;
    if (index === -1) throw Error("Selected character is missing. Reload the conversation.");
    const characters = [];
    let total = 0;
    // Sequential reads bound memory and network load even alongside the other
    // startup adapters. Never expose a partially loaded or changed directory.
    for (const row of listing) {
      const card = await get(`/characters/${encodeURIComponent(row.id)}`);
      if (!object(card) || bytes(card) > 4_194_304 || card.id !== row.id || card.avatar !== row.avatar || card.name !== row.name || card.revision !== row.revision || !object(card.raw) || !object(card.data)) throw Error("Invalid character card or changed revision. Reload the extension.");
      total += bytes(card);
      if (total > 16_777_216) throw Error("Character snapshot exceeds 16 MiB.");
      // Match upstream's top-level V1 fields and nested data without replacing
      // opaque card fields with the V1 transport envelope. No dates/statistics
      // or default chat filenames are invented here.
      const character = { ...card.raw, ...card.data, data: card.raw.data ?? card.data, name: card.name, avatar: card.avatar, shallow: false };
      if (selection?.kind === "character" && row.id === selection.id) character.chat = selection.chatId;
      characters.push(character);
    }
    if (JSON.stringify(catalog(await get("/characters"))) !== JSON.stringify(listing)) throw Error("Character catalog changed. Reload the extension.");
    checkCurrent();
    return { characters, ...(index === undefined ? {} : { characterId: index }), ...(selection?.kind === "group" ? { groupId: selection.id } : {}), ...(selection ? { chatId: selection.chatId } : {}) };
  };
  const readWorldSnapshot = async () => {
    const checkCurrent = () => { if (signal?.aborted || (options.isCurrent && !options.isCurrent())) throw Error("Extension session was replaced or aborted. Reload before continuing."); };
    const get = async (path: string) => { checkCurrent(); const value = await api<any>(path, { signal }); checkCurrent(); return value; };
    const object = (value: any) => value && typeof value === "object" && !Array.isArray(value);
    const bytes = (value: any) => new TextEncoder().encode(JSON.stringify(value)).length;
    const validName = (value: any) => safeId(value) && !value.endsWith(".");
    const names = (value: any): string[] => {
      if (!Array.isArray(value) || value.length > 512 || value.some(item => !validName(item)) || new Set(value).size !== value.length) throw Error("Invalid or oversized World Info name list.");
      return [...value];
    };
    const catalog = (value: any) => {
      if (!object(value) || bytes(value) > 131_072 || !Array.isArray(value.books) || value.books.length > 512 || !Array.isArray(value.warnings) || value.warnings.length) throw Error("Invalid, unreadable or oversized World Info catalog.");
      const seen = new Set<string>();
      return value.books.map((row: any) => {
        if (!object(row) || !validName(row.name) || seen.has(row.name) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 4_194_304) throw Error("Invalid World Info catalog entry.");
        seen.add(row.name); return { name: row.name as string, bytes: row.bytes as number };
      });
    };
    const [document, listing] = await Promise.all([get("/world-info-settings"), get("/world-info")]);
    if (!object(document) || bytes(document) > 1_048_576 || typeof document.revision !== "string" || !document.revision || !object(document.settings)) throw Error("Invalid or oversized World Info settings.");
    const books: { name: string; bytes: number }[] = catalog(listing);
    const bookNames = new Set(books.map(book => book.name));
    const value = document.settings;
    const settings: Record<string, any> = {};
    for (const key of ["world_info_include_names", "world_info_recursive", "world_info_case_sensitive", "world_info_match_whole_words", "world_info_use_group_scoring"]) {
      if (value[key] === undefined) continue;
      if (typeof value[key] !== "boolean") throw Error("Invalid World Info settings switch.");
      settings[key] = value[key];
    }
    const ranges: Record<string, number> = { world_info_depth: 1000, world_info_min_activations: 20000, world_info_min_activations_depth_max: 1000, world_info_character_strategy: 2, world_info_max_recursion_steps: 2000 };
    for (const [key, max] of Object.entries(ranges)) {
      if (value[key] === undefined) continue;
      if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > max) throw Error("Invalid World Info settings range.");
      settings[key] = value[key];
    }
    const info = value.world_info ?? {};
    // Preserve source legacy string/list selection on read without rewriting
    // native settings. Only known binding fields cross into the frame.
    let selected: string[];
    if (typeof info === "string" || Array.isArray(info)) {
      selected = names(typeof info === "string" ? [info] : info);
      settings.world_info = {};
    } else {
      if (!object(info)) throw Error("Invalid World Info bindings.");
      selected = names(info.globalSelect ?? []);
      if (!Array.isArray(info.charLore ?? []) || (info.charLore?.length ?? 0) > 512) throw Error("Invalid World Info character bindings.");
      const seen = new Set<string>();
      const charLore = (info.charLore ?? []).map((row: any) => {
        if (!object(row) || !safeId(row.name) || seen.has(row.name)) throw Error("Invalid World Info character binding.");
        seen.add(row.name); return { name: row.name, extraBooks: names(row.extraBooks) };
      });
      settings.world_info = { ...(Object.hasOwn(info, "globalSelect") ? { globalSelect: [...selected] } : {}), ...(Object.hasOwn(info, "charLore") ? { charLore } : {}) };
      for (const row of charLore) if (row.extraBooks.some((name: string) => !bookNames.has(name))) throw Error("Bound World Info book is missing from the catalog.");
    }
    if (selected.some(name => !bookNames.has(name))) throw Error("Selected World Info book is missing from the catalog.");
    const [latestSettings, latestListing] = await Promise.all([get("/world-info-settings"), get("/world-info")]);
    if (latestSettings?.revision !== document.revision || JSON.stringify(catalog(latestListing)) !== JSON.stringify(books)) throw Error("World Info settings or catalog changed. Reload the extension.");
    checkCurrent();
    return { names: books.map(book => book.name), selected, settings };
  };
  let worldSnapshot: Promise<any> | undefined;
  const readExtensionCatalog = async () => {
    const checkCurrent = () => { if (signal?.aborted || (options.isCurrent && !options.isCurrent())) throw Error("Extension session was replaced or aborted. Reload before continuing."); };
    checkCurrent();
    const result = await api<any>("/extensions", { signal });
    checkCurrent();
    if (!Array.isArray(result) || result.length > 512 || new TextEncoder().encode(JSON.stringify(result)).length > 1_048_576) throw Error("Invalid or oversized extension catalog.");
    const ids = new Set<string>();
    const rows = result.map(row => {
      if (!row || typeof row.id !== "string" || ids.has(row.id)) throw Error("Invalid extension catalog entry.");
      const parts = row.id.split("/");
      const type = parts.length === 1 ? "system" : parts.length === 2 && ["local", "global"].includes(parts[0]) ? parts[0] : undefined;
      const name = parts.at(-1);
      if (!type || !safeId(name) || (row.type !== undefined && row.type !== type)) throw Error("Invalid extension catalog identity.");
      ids.add(row.id);
      return { name: type === "system" ? name! : `third-party/${name}`, type };
    });
    // Upstream discovery gives a local installation precedence over a global
    // installation with the same third-party name, regardless of input order.
    const local = new Set(rows.filter(row => row.type === "local").map(row => row.name));
    const selected = ["system", "local", "global"].flatMap(type => rows.filter(row => row.type === type && (type !== "global" || !local.has(row.name))));
    return { names: selected.map(row => row.name), types: Object.fromEntries(selected.map(row => [row.name, row.type])) };
  };
  let extensionCatalog: Promise<any> | undefined;
  const readRegexSnapshot = async () => {
    const checkCurrent = () => { if (signal?.aborted || (options.isCurrent && !options.isCurrent())) throw Error("Extension session was replaced or aborted. Reload before continuing."); };
    const get = async (path: string) => { checkCurrent(); const value = await api<any>(path, { signal }); checkCurrent(); return value; };
    const object = (value: any) => value && typeof value === "object" && !Array.isArray(value);
    const bounded = (value: any) => { if (!object(value) || new TextEncoder().encode(JSON.stringify(value)).length > 1_048_576) throw Error("Invalid or oversized regex snapshot document."); };
    const scripts = (value: any): any[] => {
      if (!Array.isArray(value) || value.length > 512) throw Error("Invalid or oversized regex script list.");
      return value.map(script => {
        if (!object(script) || typeof script.findRegex !== "string" || typeof script.replaceString !== "string" || !Array.isArray(script.placement) || script.placement.some((item: any) => ![0, 1, 2, 3, 5, 6].includes(item))) throw Error("Invalid regex script.");
        if (script.trimStrings !== undefined && (!Array.isArray(script.trimStrings) || script.trimStrings.some((item: any) => typeof item !== "string"))) throw Error("Invalid regex trim strings.");
        for (const key of ["disabled", "markdownOnly", "promptOnly", "runOnEdit"]) if (script[key] !== undefined && typeof script[key] !== "boolean") throw Error("Invalid regex script switches.");
        for (const key of ["minDepth", "maxDepth"]) if (script[key] != null && (!Number.isInteger(script[key]) || script[key] < -1 || script[key] > 10000)) throw Error("Invalid regex script depth.");
        if (script.substituteRegex !== undefined && ![0, 1, 2].includes(script.substituteRegex)) throw Error("Invalid regex substitution mode.");
        for (const key of ["id", "scriptName"]) if (script[key] !== undefined && typeof script[key] !== "string") throw Error("Invalid regex script identity.");
        // Project known script fields only. Opaque extension fields, connection
        // metadata, provider settings and revision envelopes stay in the parent.
        const fields = ["id", "scriptName", "findRegex", "replaceString", "placement", "disabled", "markdownOnly", "promptOnly", "runOnEdit", "substituteRegex", "minDepth", "maxDepth"];
        return { ...Object.fromEntries(fields.filter(key => Object.hasOwn(script, key)).map(key => [key, Array.isArray(script[key]) ? [...script[key]] : script[key]])), trimStrings: [...(script.trimStrings ?? [])] };
      });
    };
    const names = (value: any) => Array.isArray(value) && value.length <= 512 && value.every(item => typeof item === "string" && item.length > 0 && item.length <= 512) && new Set(value).size === value.length;
    const [initial, settings] = await Promise.all([get("/regex-settings"), get("/settings")]);
    bounded(initial);
    const document = initial.settings;
    if (typeof initial.revision !== "string" || !initial.revision || !object(document) || typeof document.enabled !== "boolean" || !names(document.characterAllowed) || !object(document.presetAllowed) || Object.keys(document.presetAllowed).length > 32 || Object.entries(document.presetAllowed).some(([key, value]) => !key || key.length > 256 || !names(value))) throw Error("Invalid regex settings or scope grants.");
    const globalScripts = scripts(document.scripts);
    const mainApi = settings?.typed?.main_api;
    if (typeof mainApi !== "string" || mainApi.length > 256) throw Error("Invalid regex API settings response.");
    const kinds: Record<string, string> = { openai: "chat-completion", context: "context", instruct: "instruct", sysprompt: "sysprompt" };
    const kind = Object.hasOwn(kinds, mainApi) ? kinds[mainApi] : undefined;
    let active: any;
    let presetScripts: any[] = [];
    if (kind) {
      active = await get(`/preset-settings/${kind}`);
      bounded(active);
      if (active.kind !== kind || typeof active.name !== "string" || active.name.length > 256 || typeof active.revision !== "string" || !active.revision || !object(active.preset)) throw Error("Invalid active regex preset snapshot.");
      const extensions = active.preset.extensions;
      if (extensions != null && !object(extensions)) throw Error("Invalid preset regex extensions.");
      presetScripts = scripts(extensions?.regex_scripts ?? []);
    }
    const [latest, latestSettings, latestActive] = await Promise.all([get("/regex-settings"), get("/settings"), ...(kind ? [get(`/preset-settings/${kind}`)] : [])]);
    if (latest?.revision !== initial.revision || latestSettings?.typed?.main_api !== mainApi || (kind && (latestActive?.kind !== kind || latestActive?.revision !== active.revision || latestActive?.name !== active.name))) throw Error("Regex settings, grants or active preset changed. Reload the extension.");
    checkCurrent();
    return { enabled: document.enabled, scripts: globalScripts, characterAllowed: [...document.characterAllowed], presetAllowed: Object.fromEntries(Object.entries(document.presetAllowed).map(([key, value]) => [key, [...value as string[]]])), apiId: kind ? mainApi : null, presetName: kind ? active.name : null, presetScripts };
  };
  let regexSnapshot: Promise<any> | undefined;
  const readPresetSnapshot = async () => {
    const kinds = ["chat-completion", "context", "instruct", "sysprompt"];
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    const validName = (name: unknown): name is string => typeof name === "string" && name.length > 0 && name === name.trim() && new TextEncoder().encode(name).length <= 200 && !/[\\/:*?"<>|\x00-\x1f]/.test(name) && !name.includes("..") && !name.endsWith(".");
    const object = (value: any) => value && typeof value === "object" && !Array.isArray(value);
    let total = 0, nodes = 0;
    // Preset endpoints also contain connection configuration. Apply a stricter
    // frame projection recursively, including opaque extension data; never send
    // their response envelope or provider connection metadata into the frame.
    const privateKey = /^(?:__proto__|prototype|constructor|api[_-]?key|.*[_-]api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|key|.*password|secret|.*[_-]secret|custom_include_headers|custom_include_body|custom_exclude_body|custom_url|reverse_proxy|apiurl|api_server|server_urls|streaming_url|azure_base_url|azure_deployment_name|vertexai_region|vertexai_express_project_id|workers_ai_account_id|proxy_preset|proxies|proxy|headers|url)$/i;
    const project = (value: any, depth = 0): any => {
      if (++nodes > 200_000 || depth > 64) throw Error("Preset snapshot nesting or node limit exceeded.");
      if (Array.isArray(value)) return value.map(item => project(item, depth + 1));
      if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKey.test(key)).map(([key, item]) => [key, project(item, depth + 1)]));
      if (typeof value === "string") {
        // Do not expose embedded credential URLs even in opaque preset values.
        if (/^https?:\/\//i.test(value)) {
          try { const url = new URL(value); if (url.username || url.password) return "[redacted]"; } catch { /* Ordinary non-URL text. */ }
        }
      }
      return value;
    };
    const checkCurrent = () => { if (signal?.aborted || (options.isCurrent && !options.isCurrent())) throw Error("Extension session was replaced or aborted. Reload before continuing."); };
    const get = async (path: string) => { checkCurrent(); const result = await api<any>(path, { signal }); checkCurrent(); return result; };
    const settings = await get("/settings");
    const mainApi = settings?.typed?.main_api;
    if (typeof mainApi !== "string" || mainApi.length > 256) throw Error("Invalid preset API settings response.");
    const catalog = (value: any, kind: string) => {
      if (!object(value) || value.kind !== kind || typeof value.activeName !== "string" || (value.activeName !== "" && !validName(value.activeName)) || typeof value.activeRevision !== "string" || !value.activeRevision || !Array.isArray(value.presets) || value.presets.length > 128 || !Array.isArray(value.warnings) || value.warnings.length || bytes(value) > 131_072) throw Error("Invalid, unreadable or oversized preset catalog.");
      const names = new Set<string>();
      const presets: { name: string; revision: string; origin: string }[] = value.presets.map((row: any) => {
        if (!object(row) || !validName(row.name) || names.has(row.name) || typeof row.revision !== "string" || !row.revision || !["user", "builtin"].includes(row.origin)) throw Error("Invalid preset catalog entry.");
        names.add(row.name); return { name: row.name, revision: row.revision, origin: row.origin };
      });
      return { kind, activeName: value.activeName, activeRevision: value.activeRevision, presets };
    };
    const catalogs = await Promise.all(kinds.map(async kind => catalog(await get(`/presets/${kind}`), kind)));
    if (catalogs.reduce((sum, item) => sum + item.presets.length, 0) > 256) throw Error("Preset snapshot exceeds 256 presets.");
    const snapshots = new Map<string, { kind: string; activeName: string; settings: any; presets: { name: string; preset: any }[] }>();
    const jobs: (() => Promise<void>)[] = [];
    const sanitize = (value: any) => {
      if (!object(value) || bytes(value) > 1_048_576) throw Error("Invalid or oversized preset document.");
      // Count before projection too: filtering must not hide an oversized graph.
      total += bytes(value);
      if (total > 8_388_608) throw Error("Preset snapshot exceeds 8 MiB.");
      return project(value);
    };
    for (const item of catalogs) {
      const snapshot = { kind: item.kind, activeName: item.activeName, settings: undefined as any, presets: item.presets.map(row => ({ name: row.name, preset: undefined as any })) };
      snapshots.set(item.kind, snapshot);
      jobs.push(async () => {
        const active = await get(`/preset-settings/${item.kind}`);
        if (!object(active) || active.kind !== item.kind || active.name !== item.activeName || active.revision !== item.activeRevision) throw Error("Active preset changed. Reload the extension.");
        snapshot.settings = sanitize(active.preset);
      });
      item.presets.forEach((row, index) => jobs.push(async () => {
        const result = await get(`/presets/${item.kind}/${encodeURIComponent(row.name)}`);
        if (!object(result) || result.kind !== item.kind || result.name !== row.name || result.revision !== row.revision || result.origin !== row.origin) throw Error("Preset changed. Reload the extension.");
        snapshot.presets[index].preset = sanitize(result.preset);
      }));
    }
    // Bound in-flight GETs; synchronous upstream reads require a fully loaded
    // snapshot, but do not need an unbounded request burst on startup.
    let next = 0, stopped = false;
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (!stopped && next < jobs.length) {
        const job = jobs[next++];
        try { await job(); } catch (error) { stopped = true; throw error; }
      }
    }));
    for (const previous of catalogs) {
      const latest = catalog(await get(`/presets/${previous.kind}`), previous.kind);
      if (JSON.stringify(latest) !== JSON.stringify(previous)) throw Error("Preset catalog or active settings changed. Reload the extension.");
    }
    const latestSettings = await get("/settings");
    if (latestSettings?.typed?.main_api !== mainApi) throw Error("Active API changed. Reload the extension.");
    checkCurrent();
    return { mainApi, catalogs: [...snapshots.values()] };
  };
  let presetSnapshot: Promise<any> | undefined;
  let cleanupSnapshot: Promise<any> | undefined;
  const personaCatalog = (result: any) => {
    if (!result || typeof result.revision !== "string" || !result.revision || typeof result.username !== "string" || result.username.length > 65_536 || (result.selectedId !== "" && !safeId(result.selectedId)) || !Array.isArray(result.personas) || result.personas.length > 128) throw Error("Invalid Persona catalog response.");
    const personas = result.personas.map((row: any) => {
      if (!row || !safeId(row.id) || typeof row.name !== "string") throw Error("Invalid Persona catalog entry.");
      return { id: row.id, name: row.name };
    });
    if (new Set(personas.map((row: any) => row.id)).size !== personas.length || new TextEncoder().encode(JSON.stringify(personas)).length > 1_048_576) throw Error("Invalid or oversized Persona catalog.");
    personaRevision = result.revision;
    personaIds = new Set(personas.map((row: { id: string }) => row.id));
    return { selectedId: result.selectedId, username: result.username, personas };
  };
  return async (operation: unknown, args: unknown) => {
    checkCurrent();
    if (operation === "provider.status") {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw Error("Invalid extension resource arguments.");
      const result = await api<any>("/provider-status", { signal });
      checkCurrent();
      if (!result || !["unchecked", "checking", "valid", "failed"].includes(result.state) || result.onlineStatus !== (result.state === "valid" ? "Valid" : "no_connection") || (["valid", "failed"].includes(result.state) ? !Number.isSafeInteger(result.checkedAt) || result.checkedAt < 0 : result.checkedAt !== null)) throw Error("Invalid native provider status response.");
      return result.onlineStatus as "Valid" | "no_connection";
    }
    if (operation === "chat.snapshot") {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw Error("Invalid extension resource arguments.");
      chatSnapshot ??= readChatSnapshot();
      const snapshot = await chatSnapshot;
      checkCurrent();
      return snapshot;
    }
    if (operation === "characters.snapshot") {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw Error("Invalid extension resource arguments.");
      characterSnapshot ??= readCharacters();
      const snapshot = await characterSnapshot;
      checkCurrent();
      return snapshot;
    }
    if (operation === "chat.setSendButtonsEnabled") {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 1 || !Object.hasOwn(args, "enabled") || typeof (args as any).enabled !== "boolean") throw Error("Invalid extension resource arguments.");
      if (!options.setSendButtonsEnabled || !signal) throw Error("Send button controls require an extension interface opened inside a selected conversation.");
      options.setSendButtonsEnabled((args as { enabled: boolean }).enabled, signal);
      checkCurrent();
      return null;
    }
    if (operation === "chat.printMessages") {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw Error("Invalid extension resource arguments.");
      if (!options.printMessages) throw Error("printMessages requires an extension interface opened inside a selected conversation.");
      await options.printMessages(signal);
      checkCurrent();
      // Completion only. No transcript, identity, credentials or API paths
      // cross into the frame, and the caller cannot choose a different chat.
      return null;
    }
    if (operation === "script.cleanupSettings") {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw Error("Invalid extension resource arguments.");
      cleanupSnapshot ??= (async () => {
        const result = await api<any>("/settings", { signal });
        checkCurrent();
        const settings = result?.typed;
        if (!settings || typeof settings.main_api !== "string" || settings.main_api.length > 256) throw Error("Invalid cleanup API settings.");
        const power = settings.power_user ?? {};
        if (!power || typeof power !== "object" || Array.isArray(power)) throw Error("Invalid cleanup settings.");
        const visible: Record<string, string | boolean> = { mainApi: settings.main_api };
        for (const key of ["collapse_newlines", "trim_sentences", "auto_fix_generated_markdown", "allow_name1_display", "allow_name2_display", "trim_spaces"]) {
          if (power[key] === undefined) continue;
          if (typeof power[key] !== "boolean") throw Error("Invalid cleanup settings switch.");
          visible[key] = power[key];
        }
        if (power.context !== undefined) {
          if (!power.context || typeof power.context !== "object" || Array.isArray(power.context)) throw Error("Invalid example context settings.");
          if (power.context.example_separator !== undefined) {
            const separator = power.context.example_separator;
            if (typeof separator !== "string" || new TextEncoder().encode(separator).length > 65_536) throw Error("Invalid or oversized example separator.");
            visible.exampleSeparator = separator;
          }
        }
        if (power.user_prompt_bias !== undefined) {
          if (typeof power.user_prompt_bias !== "string" || new TextEncoder().encode(power.user_prompt_bias).length > 65_536) throw Error("Invalid or oversized cleanup prompt bias.");
          visible.hasUserPromptBias = power.user_prompt_bias.length > 0;
        }
        return visible;
      })();
      const snapshot = await cleanupSnapshot;
      checkCurrent();
      return snapshot;
    }
    if (operation === "worldInfo.snapshot" || operation === "extensions.catalog") {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw Error("Invalid extension resource arguments.");
      const snapshot = await (operation === "worldInfo.snapshot" ? worldSnapshot ??= readWorldSnapshot() : extensionCatalog ??= readExtensionCatalog());
      if (signal?.aborted || (options.isCurrent && !options.isCurrent())) throw Error("Extension session was replaced or aborted. Reload before continuing.");
      return snapshot;
    }
    if (operation === "regex.snapshot") {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw Error("Invalid extension resource arguments.");
      regexSnapshot ??= readRegexSnapshot();
      const snapshot = await regexSnapshot;
      if (signal?.aborted || (options.isCurrent && !options.isCurrent())) throw Error("Extension session was replaced or aborted. Reload before continuing.");
      return snapshot;
    }
    if (operation === "presets.snapshot") {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw Error("Invalid extension resource arguments.");
      // A failed/uncertain initialization stays failed; no silent retry or
      // subsequent read can publish a mixture from another native revision.
      presetSnapshot ??= readPresetSnapshot();
      const snapshot = await presetSnapshot;
      if (signal?.aborted || (options.isCurrent && !options.isCurrent())) throw Error("Extension session was replaced or aborted. Reload before continuing.");
      return snapshot;
    }
    if (operation === "personas.read" || operation === "reasoning.settings" || operation === "user.identity" || operation === "openai.settings") {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw Error("Invalid extension resource arguments.");
      if (operation === "user.identity") {
        const result = await api<any>("/session", { signal });
        checkCurrent();
        if (!result || result.authenticated !== true || !safeId(result.handle) || typeof result.accountsEnabled !== "boolean" || typeof result.admin !== "boolean") throw Error("Invalid authenticated identity response. Update the server and reload the extension.");
        return { handle: result.handle, accountsEnabled: result.accountsEnabled, admin: result.admin };
      }
      if (operation === "personas.read") {
        if (selecting) throw Error("Persona selection is pending.");
        personaReads++;
        try {
          const result = await api("/personas", { signal });
          checkCurrent();
          return personaCatalog(result);
        }
        finally { personaReads--; }
      }
      const result = await api<any>("/settings", { signal });
      checkCurrent();
      const settings = result?.typed;
      if (!settings || typeof settings !== "object") throw Error("Invalid reasoning settings response.");
      if (operation === "openai.settings") {
        const oai = settings.oai_settings;
        if (!oai || typeof oai.chat_completion_source !== "string" || oai.chat_completion_source.length > 256) throw Error("Invalid Chat Completion settings response.");
        const visible: Record<string, string | boolean | number> = { chat_completion_source: oai.chat_completion_source, show_thoughts: oai.show_thoughts === true };
        const fields = "openai_model claude_model openrouter_model ai21_model google_model vertexai_model mistralai_model custom_model cohere_model perplexity_model groq_model electronhub_model chutes_model nanogpt_model deepseek_model aimlapi_model xai_model pollinations_model moonshot_model fireworks_model cometapi_model azure_openai_model zai_model siliconflow_model workers_ai_model minimax_model".split(" ");
        for (const key of fields) {
          if (oai[key] === undefined) continue;
          if (typeof oai[key] !== "string" || oai[key].length > 8192) throw Error("Invalid or oversized Chat Completion model identifier.");
          visible[key] = oai[key];
        }
        for (const key of ["openai_max_context", "openai_max_tokens"]) {
          if (oai[key] === undefined) continue;
          if (!Number.isSafeInteger(oai[key]) || oai[key] < (key === "openai_max_context" ? 1 : 0)) throw Error("Invalid Chat Completion token limit.");
          visible[key] = oai[key];
        }
        return visible;
      }
      // Only the four scalar switches needed for parsing; never provider keys,
      // URLs, headers, prompt settings or the surrounding settings object.
      const kind = (value: any, optional = false) => {
        if (value === undefined && optional) return "";
        if (typeof value !== "string" || value.length > 256) throw Error("Invalid or oversized reasoning settings identifier.");
        return value;
      };
      return {
        mainApi: kind(settings.main_api),
        source: kind(settings.oai_settings?.chat_completion_source, true),
        showThoughts: settings.oai_settings?.show_thoughts === true,
        textGenType: kind(settings.textgenerationwebui_settings?.type, true),
      };
    }
    if (operation === "personas.select") {
      if (!options.allowPersonaSelection) throw Error("Persona selection is read-only in this extension host.");
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key !== "id") || !safeId((args as any).id)) throw Error("Invalid Persona selection arguments.");
      if (!personaRevision || selecting || personaReads || selectionFailed) throw Error("Persona selection is unavailable. Reload the extension before continuing.");
      if (!personaIds.has((args as any).id)) throw Error("Persona not found in the inspected catalog.");
      selecting = true;
      try {
        const result = await api(`/personas/${encodeURIComponent((args as any).id)}/select`, { method: "POST", body: JSON.stringify({ expectedRevision: personaRevision }), signal });
        checkCurrent();
        return personaCatalog(result);
      } catch (cause) { selectionFailed = true; throw cause; }
      finally { selecting = false; }
    }
    if (operation !== "worldInfo.load") throw Error("Unsupported extension resource operation.");
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key !== "name")) throw Error("Invalid extension resource arguments.");
    const { name } = args as { name?: unknown };
    if (!safeId(name)) throw Error("Invalid World Info name.");
    const result = await api<{ book: unknown }>(`/world-info/${encodeURIComponent(name)}`, { signal });
    if (signal?.aborted || (options.isCurrent && !options.isCurrent())) throw Error("Extension session was replaced or aborted. Reload before continuing.");
    if (!result?.book || typeof result.book !== "object" || Array.isArray(result.book)) throw Error("Invalid World Info response.");
    if (new TextEncoder().encode(JSON.stringify(result.book)).length > 4_194_304) throw Error("World Info response exceeds 4 MiB.");
    return result.book;
  };
}

// Parent-only observation. Polling reads local backend state; it never triggers
// a remote provider check. Abort disposes both the timer and in-flight read.
export function observeExtensionProviderStatus(read: (operation: string, args: object) => Promise<any>, publish: (value: "Valid" | "no_connection") => void, signal: AbortSignal) {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { stopped = true; clearTimeout(timer); signal.removeEventListener("abort", stop); };
  if (signal.aborted) return stop;
  signal.addEventListener("abort", stop, { once: true });
  const poll = async () => {
    if (stopped || signal.aborted) return;
    let status: "Valid" | "no_connection" = "no_connection";
    try { const value = await read("provider.status", {}); if (value === "Valid" || value === "no_connection") status = value; } catch { /* An unavailable backend cannot retain a connected observation. */ }
    if (stopped || signal.aborted) return;
    publish(status);
    timer = setTimeout(() => { void poll(); }, 5000);
  };
  void poll();
  return stop;
}
