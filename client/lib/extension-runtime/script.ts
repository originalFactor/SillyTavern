// Serialized into the opaque-origin frame; keep all dependencies in this function.
// Authorities: STOriginal/public/script.js and scripts/system-messages.js.
export function installExtensionScript(w: any, host: any) {
  let snapshot: { characters: any[]; characterId?: number; groupId?: string; chatId?: string } | undefined;
  let chatSnapshot: { bound: boolean; chat: any[]; chatMetadata: Record<string, any> } | undefined;
  let initialization: Promise<void> | undefined;
  let onlineStatus: "Valid" | "no_connection" | undefined;
  let generationState = { isSendPress: false, isGroupGenerating: false };
  const updateGenerationState = (value: any) => {
    if (!value || typeof value.isSendPress !== "boolean" || typeof value.isGroupGenerating !== "boolean") throw Error("Invalid native generation state.");
    generationState = { isSendPress: value.isSendPress, isGroupGenerating: value.isGroupGenerating };
    host.publish?.("/script.js", "is_send_press", generationState.isSendPress);
  };
  const updateOnlineStatus = (value: unknown) => {
    if (value !== "Valid" && value !== "no_connection") throw Error("Invalid native provider status.");
    const previous = onlineStatus;
    onlineStatus = value;
    host.publish?.("/script.js", "online_status", value);
    if (previous !== undefined && previous !== value) host.eventSource.emitAndWait(host.events.ONLINE_STATUS_CHANGED, value);
  };
  const state = () => snapshot ?? host.unsupported("characters (native catalog snapshot is not loaded)");
  const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
  const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
  const promptKey = (key: unknown): key is string => typeof key === "string" && key.length > 0 && key.length <= 128 && !/[\x00-\x1f\x7f]/.test(key) && !["__proto__", "constructor", "prototype"].includes(key);
  const writablePrompts = () => {
    if (!host.promptInjectionEnabled) return host.unsupported("setExtensionPrompt (native generation prompt injection is not bound to this conversation)");
  };
  const promptData = (entry: any) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.value !== "string" || entry.value.length > 65_536 || ![-1, 0, 1, 2].includes(entry.position) || !Number.isInteger(entry.depth) || entry.depth < 0 || entry.depth > 10000 || typeof entry.scan !== "boolean" || ![0, 1, 2].includes(entry.role) || (entry.filter != null && typeof entry.filter !== "function")) throw Error("Invalid or oversized extension prompt.");
    return { value: entry.value, position: entry.position, depth: entry.depth, scan: entry.scan, role: entry.role };
  };
  const promptEntries: Record<string, any> = Object.create(null);
  const extension_prompts = new Proxy(promptEntries, {
    set(target, key, entry) {
      writablePrompts();
      if (!promptKey(key) || (!Object.hasOwn(target, key) && Object.keys(target).length >= 128)) throw Error("Invalid or oversized extension prompt key.");
      promptData(entry);
      Object.defineProperty(target, key, { value: entry, enumerable: true, writable: true, configurable: true });
      return true;
    },
    defineProperty() { throw Error("Extension prompt descriptors are not supported; assign a prompt entry instead."); },
    setPrototypeOf() { throw Error("Extension prompt prototypes cannot be changed."); },
    deleteProperty(target, key) { writablePrompts(); return Reflect.deleteProperty(target, key); },
  });
  function setExtensionPrompt(key: any, value: any, position: any, depth: any, scan = false, role: any = extension_prompt_roles.SYSTEM, filter: any = null) {
    writablePrompts();
    extension_prompts[key] = { value: String(value), position: Number(position), depth: Number(depth), scan: !!scan, role: Number(role ?? extension_prompt_roles.SYSTEM), filter };
  }
  const collectExtensionPrompts = async () => {
    // Freeze data before awaiting predicates. Functions stay in this frame;
    // the native request receives only the resolved, bounded data snapshot.
    const entries = Object.keys(promptEntries).sort().map(key => ({ key, data: promptData(promptEntries[key]), filter: promptEntries[key].filter }));
    const result: Record<string, any> = Object.create(null);
    for (const entry of entries) {
      if (typeof entry.filter === "function" && !await entry.filter()) continue;
      result[entry.key] = entry.data;
    }
    if (new TextEncoder().encode(JSON.stringify(result)).length > 1_048_576) throw Error("Extension prompts exceed 1 MiB.");
    return result;
  };
  const tokenLimit = (key: string) => {
    if (host.reasoning.getMainApi() !== "openai") return host.unsupported(`${key} (only Chat Completion token limits are bound)`);
    const value = host.openai.oai_settings[key];
    if (!Number.isSafeInteger(value) || value < (key === "openai_max_context" ? 1 : 0)) return host.unsupported(`${key} (configured token limit is unavailable)`);
    return value as number;
  };
  const getMaxContextTokens = () => tokenLimit("openai_max_context");
  const getMaxResponseTokens = () => tokenLimit("openai_max_tokens");
  const getMaxPromptTokens = (overrideResponseLength: unknown = null) => {
    // Source behavior deliberately accepts positive fractions/Infinity and
    // leaves negative remaining budgets unclamped. This is a query only.
    if (typeof overrideResponseLength !== "number" || overrideResponseLength <= 0 || isNaN(overrideResponseLength)) overrideResponseLength = null;
    return getMaxContextTokens() - ((overrideResponseLength as number | null) || getMaxResponseTokens());
  };
  // These exports must be importable before an extension decides which features
  // to use. Native paging is not the complete, mutable upstream chat snapshot;
  // neither a redraw nor a successful settings write can stand in for saving it.
  const saveChatConditional = async () => {
    return host.unsupported("saveChatConditional (mutable chat state and transcript persistence lifecycle are not bound)");
  };
  function substituteParams(content: any, ..._options: any[]) {
    if (!content) return "";
    const text = typeof content === "string" ? content : String(content);
    // Literal-only projection: do not evaluate native context, additional
    // macros or post-process callbacks in this isolated frame.
    if (text.includes("{{") || /<(?:USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/i.test(text)) return host.unsupported("substituteParams (native macro evaluation context is not bound)");
    return text;
  }
  function substituteParamsExtended(content: any, additionalMacro: any = {}, postProcessFn: any = (x: any) => x) {
    return substituteParams(content, { dynamicMacros: additionalMacro, postProcessFn });
  }
  function extractMessageBias(message: any) {
    if (!message) return "";
    try {
      const handlebars = w.Handlebars.create();
      const matches: any[] = [];
      handlebars.registerHelper("bias", (text: any) => { matches.push(text); return ""; });
      handlebars.compile(message)({});
      return matches.length ? ` ${matches.join(" ")}` : "";
    } catch { return ""; }
  }
  // The source entry points must link before extensions choose a code path.
  // These operations depend on the upstream editor, mutable state or legacy
  // media/DOM. Fail before reading inputs or scheduling side effects; never
  // route them to settings persistence or treat a paged view as the full chat.
  const syncGuards = {
    saveCharacterDebounced: "character editor draft and revision-checked save lifecycle are not bound",
    getThumbnailUrl: "native media assets are not bound",
    getCharacterCardFields: "selected character and native macro context are not bound",
    messageFormatting: "upstream message renderer and native macro context are not bound",
    addOneMessage: "upstream chat DOM and mutable chat state are not bound",
    reloadMarkdownProcessor: "upstream Markdown renderer is not bound",
    showSwipeButtons: "upstream swipe DOM is not bound; use activateSendButtons for the native UI lock",
    setGenerationProgress: "extension-owned native generation progress is not bound",
    setUserName: "native Persona mutation lifecycle is not bound",
    scrollChatToBottom: "standalone native scrolling is not bound; use printMessages for a native redraw and scroll",
  };
  const asyncGuards = {
    clearChat: "upstream chat DOM and mutable chat state are not bound",
    reloadCurrentChat: "mutable chat snapshot reload lifecycle is not bound; use printMessages for native redraw",
    deleteCharacter: "character digest and deletion authorization lifecycle are not bound",
    getCharacters: "catalog refresh, group reload and native selection lifecycle are not bound",
    getOneCharacter: "catalog refresh and revision replacement lifecycle are not bound",
    getPastCharacterChats: "upstream character-index selection is not bound",
    printCharacters: "upstream character catalog DOM is not bound",
    selectCharacterById: "native character navigation is not bound",
  };
  const result: Record<string, any> = {
    extension_prompts, setExtensionPrompt,
    substituteParams, substituteParamsExtended, extractMessageBias,
    getBiasStrings(_textareaText: any, type: any) {
      if (type == "impersonate" || type == "continue") return { messageBias: "", promptBias: "", isUserPromptBias: false };
      return host.unsupported("getBiasStrings (native chat history, prompt-bias settings and macro context are not bound)");
    },
    async unshallowCharacter(characterId?: any) {
      // The upstream undefined-ID branch returns before consulting its catalog.
      if (characterId === undefined) return;
      if (!snapshot) return host.unsupported("unshallowCharacter (complete upstream character catalog is not bound)");
      // Every card in this bounded native catalog is already fully loaded.
      // Source also returns without a value for unknown/non-shallow indices.
      const character = snapshot.characters[characterId];
      if (!character || !character.shallow) return;
      return host.unsupported("unshallowCharacter (snapshot unexpectedly contains a shallow card)");
    },
    stopGeneration() {
      // No provider dispatch or streaming processor is admitted to this frame.
      // Preserve source notification/false-result semantics for this branch.
      void host.eventSource.emit(host.events.GENERATION_STOPPED);
      return false;
    },
    DEFAULT_SAVE_EDIT_TIMEOUT: 1000, DEFAULT_PRINT_TIMEOUT: 100,
    async printMessages() { await host.request("chat.printMessages", {}); },
    async deactivateSendButtons() { await host.request("chat.setSendButtonsEnabled", { enabled: false }); },
    async activateSendButtons() { await host.request("chat.setSendButtonsEnabled", { enabled: true }); },
    saveChatConditional,
    async saveMetadata() { return await saveChatConditional(); },
    async saveChat(..._args: any[]) {
      return host.unsupported("saveChat (mutable chat state and transcript persistence lifecycle are not bound)");
    },
    cleanUpMessage: (...args: any[]) => host.cleanup.cleanUpMessage(...args),
    baseChatReplace: (...args: any[]) => host.cleanup.baseChatReplace(...args),
    parseMesExamples: (...args: any[]) => host.cleanup.parseMesExamples(...args),
    getMaxContextTokens, getMaxResponseTokens, getMaxPromptTokens,
    // Upstream re-exports the same function under this deprecated name.
    getMaxContextSize: getMaxPromptTokens,
    get user_avatar() { return host.personas.user_avatar; },
    get main_api() { return host.reasoning.getMainApi(); },
    get online_status() { return onlineStatus ?? host.unsupported("online_status (native provider observation is not loaded)"); },
    get is_send_press() { return generationState.isSendPress; },
    isGenerating: () => generationState.isSendPress || generationState.isGroupGenerating,
    get name1() { return host.personas.getUserName(); },
    get name2() {
      const value = state();
      // This read-only frame has no active group generation member. Preserve
      // upstream's idle group name and initial no-selection system name.
      return value.characterId !== undefined ? value.characters[value.characterId].name : value.groupId !== undefined ? "" : "SillyTavern System";
    },
    get characters() { return state().characters; },
    get this_chid() { return state().characterId; },
    get chat() { if (!chatSnapshot) return host.unsupported("chat (complete native snapshot is not loaded)"); return chatSnapshot.chat; },
    get chat_metadata() { if (!chatSnapshot) return host.unsupported("chat_metadata (complete native snapshot is not loaded)"); return chatSnapshot.chatMetadata; },
    getCurrentChatId() {
      if (snapshot) return snapshot.chatId;
      const context = host.getContext?.();
      if (context?.groupId || context?.characterId !== undefined) return host.unsupported("getCurrentChatId (native chat selection is not bound)");
      // Upstream falls through without a value when neither selection exists.
      return undefined;
    },
    MAX_INJECTION_DEPTH: 10000,
    systemUserName: "SillyTavern System", neutralCharacterName: "Assistant",
    // Upstream identifiers only; the host does not serve these legacy asset URLs.
    default_avatar: "img/ai4.png", system_avatar: "img/five.png", comment_avatar: "img/quill.png", default_user_avatar: "img/user-default.png",
    extension_prompt_types, extension_prompt_roles,
    system_message_types: {
      HELP: "help", WELCOME: "welcome", EMPTY: "empty", GENERIC: "generic", NARRATOR: "narrator", COMMENT: "comment",
      SLASH_COMMANDS: "slash_commands", FORMATTING: "formatting", HOTKEYS: "hotkeys", MACROS: "macros",
      WELCOME_PROMPT: "welcome_prompt", ASSISTANT_NOTE: "assistant_note", ASSISTANT_MESSAGE: "assistant_message",
    },
    isOdd: host.utils.isOdd,
    countOccurrences: host.utils.countOccurrences,
    getExtensionPromptRoleByName(roleName: unknown) {
      if (typeof roleName === "number" && Object.values(extension_prompt_roles).includes(roleName)) return roleName;
      switch (roleName) {
        case "system": return extension_prompt_roles.SYSTEM;
        case "user": return extension_prompt_roles.USER;
        case "assistant": return extension_prompt_roles.ASSISTANT;
        default: return extension_prompt_roles.SYSTEM;
      }
    },
    createLazyFields(resolvers: Record<string, () => unknown>) {
      const result = {};
      for (const [key, resolver] of Object.entries(resolvers)) {
        let cached: unknown, resolved = false;
        Object.defineProperty(result, key, {
          get() { if (!resolved) { cached = resolver(); resolved = true; } return cached; },
          enumerable: true, configurable: true,
        });
      }
      return result;
    },
  };
  // Avoid object spreads around this literal: ES2017 compilation would use
  // Object.assign and eagerly invoke the native-state getters above.
  for (const [name, reason] of Object.entries(syncGuards)) result[name] = (..._args: any[]) => host.unsupported(`${name} (${reason})`);
  for (const [name, reason] of Object.entries(asyncGuards)) result[name] = async (..._args: any[]) => host.unsupported(`${name} (${reason})`);
  Object.defineProperty(result, "selectionGroupId", { get: () => state().groupId });
  Object.defineProperty(result, "updateOnlineStatus", { value: updateOnlineStatus });
  Object.defineProperty(result, "updateGenerationState", { value: updateGenerationState });
  Object.defineProperty(result, "collectExtensionPrompts", { value: collectExtensionPrompts });
  Object.defineProperty(result, "getChatSnapshot", { value: () => {
    if (!chatSnapshot) return host.unsupported("chat (complete native snapshot is not loaded)");
    return chatSnapshot;
  } });
  Object.defineProperty(result, "initialize", { value: () => initialization ??= (async () => {
    await host.cleanup.initialize();
    const value = await host.request("characters.snapshot", {});
    const transcript = await host.request("chat.snapshot", {});
    const providerStatus = await host.request("provider.status", {});
    // Freeze the detached snapshot, including nested opaque fields. Mutating
    // it must never look like a supported character edit or transcript save.
    const freeze = (root: any) => {
      const pending = [root];
      while (pending.length) {
        const next = pending.pop();
        if (!next || typeof next !== "object" || Object.isFrozen(next)) continue;
        Object.freeze(next);
        for (const child of Object.values(next)) if (child && typeof child === "object") pending.push(child);
      }
      return root;
    };
    snapshot = freeze(value);
    chatSnapshot = freeze(transcript);
    updateOnlineStatus(providerStatus);
  })() });
  return result;
}
