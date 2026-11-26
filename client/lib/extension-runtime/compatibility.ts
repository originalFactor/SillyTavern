// Source-derived adapters for STOriginal/public/scripts. Serialized into the frame:
// keep all implementation dependencies inside this function.
export function installExtensionCompatibility(w: any, host: any) {
  const { unsupported } = host;
  // Legacy custom macro registry, scoped to this settings frame. Registration
  // does not install callbacks into the backend's isolated macro worker.
  // Keep storage inside this serialized function: private class fields can
  // compile to helpers outside it, which do not exist in the opaque iframe.
  const customMacros = new Map<string, string | ((nonce: string) => string)>();
  const macroDescriptions = new Map<string, string>();
  class MacrosParser {
    static *[Symbol.iterator]() {
      for (const key of customMacros.keys()) yield { key, description: macroDescriptions.get(key) };
    }
    static get(key: string) { return customMacros.get(key); }
    static has(key: string) { return customMacros.has(key); }
    static registerMacro(key: string, value: any, description = "") {
      if (typeof key !== "string") throw Error("Macro key must be a string");
      key = key.trim();
      if (!key) throw Error("Macro key must not be empty or whitespace only");
      if (key.startsWith("{{") || key.endsWith("}}")) throw Error("Macro key must not include the surrounding braces");
      if (typeof value !== "string" && typeof value !== "function") value = this.sanitizeMacroValue(value);
      customMacros.set(key, value);
      // Upstream preserves a previous description on an undescribed override.
      if (typeof description === "string" && description) macroDescriptions.set(key, description);
    }
    static unregisterMacro(key: string) {
      if (typeof key !== "string") throw Error("Macro key must be a string");
      key = key.trim();
      if (!key) throw Error("Macro key must not be empty or whitespace only");
      customMacros.delete(key); macroDescriptions.delete(key);
    }
    static populateEnv(env: any) {
      if (!env || typeof env !== "object") return;
      for (const [key, value] of customMacros) env[key] = value;
    }
    static sanitizeMacroValue(value: any): string {
      if (typeof value === "string") return value;
      if (value == null || value instanceof Promise || typeof value === "function") return "";
      if (value instanceof Date) return value.toISOString();
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    }
  }
  const macros = {
    MacrosParser,
    getLastMessageId({ exclude_swipe_in_propress = true, filter = null }: any = {}) {
      if (host.getChatSnapshot) {
        const chat = host.getChatSnapshot().chat;
        for (let i = chat.length - 1; i >= 0; i--) {
          const message = chat[i];
          if (exclude_swipe_in_propress && message.swipes && message.swipe_id >= message.swipes.length) continue;
          if (!filter || filter(message)) return i;
        }
        return null;
      }
      const context = host.getContext?.();
      if (context?.groupId || context?.characterId !== undefined || context?.chat !== undefined) return unsupported("getLastMessageId (complete chat snapshot is not bound)");
      return null;
    },
    evaluateMacros: () => unsupported("evaluateMacros (upstream evaluation context is not bound)"),
    initMacros: () => unsupported("initMacros (upstream builtin registry and macro engine)"),
  };
  let identity: { handle: string; accountsEnabled: boolean; admin: boolean } | undefined;
  const requireIdentity = () => {
    if (!identity) return unsupported("user identity (authenticated session is not loaded)");
    return identity;
  };
  const user = {
    get accountsEnabled() { return requireIdentity().accountsEnabled; },
    isAdmin() { const value = requireIdentity(); return !value.accountsEnabled || value.admin; },
    getCurrentUserHandle() { const value = requireIdentity(); return value.accountsEnabled ? value.handle : "default-user"; },
    setUserControls: async () => unsupported("setUserControls (server-owned account mode and upstream account UI)"),
  };
  Object.defineProperty(user, "initialize", { value: async () => { identity = await host.request("user.identity", {}); } });
  const persona_description_positions = { IN_PROMPT: 0, AFTER_CHAR: 1, TOP_AN: 2, BOTTOM_AN: 3, AT_DEPTH: 4, NONE: 9 };
  // This settings frame has no selected character/group or chat. Keep upstream's
  // no-chat branch; never infer injection state from another host/session.
  const authorsNote = {
    NOTE_MODULE_NAME: "2_floating_prompt",
    metadata_keys: { prompt: "note_prompt", interval: "note_interval", depth: "note_depth", position: "note_position", role: "note_role" },
    shouldWIAddPrompt: false,
    setFloatingPrompt() {
      const context = host.getContext?.();
      if (context?.groupId || context?.characterId !== undefined) return unsupported("setFloatingPrompt (chat-bound Author's Note injection)");
      authorsNote.shouldWIAddPrompt = false;
    },
    initAuthorsNote: () => unsupported("initAuthorsNote (upstream Author's Note UI)"),
  };
  let parsedUA: any = null;
  const ross = {
    getParsedUA() {
      if (!parsedUA) { try { parsedUA = w.bowser.parse(w.navigator.userAgent); } catch { /* Upstream leaves failed/empty parsing uncached. */ } }
      return parsedUA;
    },
    isMobile: () => ["mobile", "tablet"].includes(ross.getParsedUA()?.platform?.type),
    humanizeGenTime(total = 0) {
      let time = Math.floor((total || 0) / 1000);
      const seconds = time % 60; time = Math.floor(time / 60);
      const minutes = time % 60; time = Math.floor(time / 60);
      const hours = time % 24, days = Math.floor(time / 24);
      return `${days > 0 ? `${days} Days, ` : ""}${hours > 0 ? `${hours} Hours, ` : ""}${minutes > 0 ? `${minutes} Minutes, ` : ""}${seconds} Seconds`;
    },
    humanizedDateTime(timestamp = Date.now()) {
      const date = new Date(timestamp), pad = (n: number, size = 2) => String(n).padStart(size, "0");
      return `${pad(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}@${pad(date.getHours())}h${pad(date.getMinutes())}m${pad(date.getSeconds())}s${pad(date.getMilliseconds(), 3)}ms`;
    },
    getMessageTimeStamp: (timestamp = Date.now()) => new Date(timestamp).toISOString(),
    favsToHotswap: async () => unsupported("favsToHotswap (upstream character navigation)"),
  };
  const constants = {
    debounce_timeout: { quick: 100, short: 200, standard: 300, relaxed: 1000, extended: 5000 },
    IGNORE_SYMBOL: Symbol.for("ignore"),
    VIDEO_EXTENSIONS: ["mp4", "avi", "mov", "wmv", "flv", "webm", "3gp", "mkv", "mpg"],
    GENERATION_TYPE_TRIGGERS: ["normal", "continue", "impersonate", "swipe", "regenerate", "quiet"],
    inject_ids: {
      STORY_STRING: "__STORY_STRING__", QUIET_PROMPT: "QUIET_PROMPT", DEPTH_PROMPT: "DEPTH_PROMPT",
      DEPTH_PROMPT_INDEX: (index: number) => `DEPTH_PROMPT_${index}`, CUSTOM_WI_DEPTH: "customDepthWI",
      CUSTOM_WI_DEPTH_ROLE: (depth: number, role: number) => `customDepthWI_${depth}_${role}`, CUSTOM_WI_OUTLET: (key: string) => `customWIOutlet_${key}`,
    },
    COMETAPI_IGNORE_PATTERNS: [
      "dall-e", "dalle", "midjourney", "mj_", "stable-diffusion", "sd-", "flux-", "playground-v", "ideogram", "recraft-", "black-forest-labs",
      "/recraft-v3", "recraftv3", "stability-ai/", "sdxl", "suno_", "tts", "whisper", "runway", "luma_", "luma-", "veo", "kling_", "minimax_video", "hunyuan-t1",
      "embedding", "search-gpts", "files_retrieve", "moderation",
    ],
    MEDIA_SOURCE: { API: "api", UPLOAD: "upload", GENERATED: "generated", CAPTIONED: "captioned" },
    MEDIA_DISPLAY: { LIST: "list", GALLERY: "gallery" },
    IMAGE_OVERSWIPE: { GENERATE: "generate", ROLLOVER: "rollover" },
    MEDIA_TYPE: {
      getFromMime: (mime: string) => mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : null,
      IMAGE: "image", VIDEO: "video", AUDIO: "audio",
    },
    MEDIA_REQUEST_TYPE: { IMAGE: 1, VIDEO: 2, AUDIO: 4 },
    SCROLL_BEHAVIOR: { NONE: "none", KEEP: "keep", ADJUST: "adjust" },
    OVERSWIPE_BEHAVIOR: { NONE: "none", LOOP: "loop", PRISTINE_GREETING: "pristine_greeting", EDIT_GENERATE: "edit_generate", REGENERATE: "regenerate" },
    SWIPE_DIRECTION: { LEFT: "left", RIGHT: "right" },
    SWIPE_SOURCE: { DELETE: "delete", KEYBOARD: "keyboard", BACK: "back", AUTO_SWIPE: "auto_swipe", SLASH_COMMAND: "slash_command", SWIPE_PICKER: "swipe_picker" },
    SWIPE_STATE: { NONE: "none", SWIPING: "swiping", EDITING: "editing" },
  };
  let catalog: { selectedId: string; username: string; personas: { id: string; name: string }[] } | undefined;
  let personaSelecting = false, personaSelectionFailed = false;
  const updatePersonas = (value: typeof catalog) => {
    const previous = catalog?.selectedId;
    catalog = value;
    host.publish?.("/script.js", "name1", catalog!.username);
    host.publish?.("/scripts/personas.js", "user_avatar", catalog!.selectedId);
    return previous;
  };
  const personas = {
    persona_description_positions,
    get user_avatar() { if (!catalog) return unsupported("user_avatar (Persona catalog is not loaded)"); return catalog.selectedId; },
    getUserAvatar: () => unsupported("getUserAvatar (V1 avatar media service)"),
    async getUserAvatars(doRender = true, _openPageAt = "") {
      if (doRender) return unsupported("getUserAvatars rendering (use false for the native Persona catalog)");
      updatePersonas(await host.request("personas.read", {}));
      return catalog!.personas.map(row => row.id);
    },
    async setUserAvatar(id: string, options: any = {}) {
      if (options.navigateToCurrent) unsupported("setUserAvatar.navigateToCurrent (upstream Persona DOM)");
      if (!catalog) unsupported("setUserAvatar (load the Persona catalog first)");
      if (typeof id !== "string" || !catalog!.personas.some(row => row.id === id)) throw Error("Persona not found in the inspected catalog.");
      if (personaSelecting || personaSelectionFailed) throw Error("Persona selection is unavailable. Reload the extension before continuing.");
      if (catalog!.selectedId === id) return;
      personaSelecting = true;
      let next;
      try { next = await host.request("personas.select", { id }); }
      catch (cause) { personaSelectionFailed = true; throw cause; }
      finally { personaSelecting = false; }
      updatePersonas(next);
      await host.eventSource?.emit(host.events.PERSONA_CHANGED, catalog!.selectedId);
    },
  };
  // Initialization is private to the frame loader, not a virtual module export.
  Object.defineProperty(personas, "initialize", { value: () => personas.getUserAvatars(false) });
  // Internal identity accessor, not an invented upstream personas.js export.
  Object.defineProperty(personas, "getUserName", { value: () => {
    if (!catalog) return unsupported("name1 (Persona catalog is not loaded)");
    return catalog.username;
  } });
  let reasoningSettings: { mainApi: string; source: string; showThoughts: boolean; textGenType: string } | undefined;
  const reasoning = {
    extractReasoningFromData(data: any, { mainApi = null, ignoreShowThoughts = false, textGenType = null, chatCompletionSource = null }: any = {}) {
      const api = mainApi ?? reasoningSettings?.mainApi;
      if (api == null) return unsupported("extractReasoningFromData (reasoning settings are not loaded)");
      if (api === "textgenerationwebui") {
        const type = textGenType ?? reasoningSettings?.textGenType;
        if (type == null) return unsupported("extractReasoningFromData.textGenType");
        if (type === "openrouter") return data?.choices?.[0]?.reasoning ?? "";
        if (type === "ollama") return data?.thinking ?? "";
        return "";
      }
      if (api !== "openai") return "";
      if (!ignoreShowThoughts) {
        if (!reasoningSettings) return unsupported("extractReasoningFromData.showThoughts");
        if (!reasoningSettings.showThoughts) return "";
      }
      const source = chatCompletionSource ?? reasoningSettings?.source;
      if (source == null) return unsupported("extractReasoningFromData.chatCompletionSource");
      const message = data?.choices?.[0]?.message;
      if (["deepseek", "xai"].includes(source)) return message?.reasoning_content ?? "";
      if (source === "openrouter") return message?.reasoning ?? message?.reasoning_content ?? "";
      if (["makersuite", "vertexai"].includes(source)) return data?.responseContent?.parts?.filter((part: any) => part.thought)?.map((part: any) => part.text)?.join("\n\n") ?? "";
      if (source === "claude") return data?.content?.filter((part: any) => part.type === "thinking")?.map((part: any) => part.thinking)?.join("\n\n") ?? "";
      if (source === "mistralai") return message?.content?.[0]?.thinking?.map((part: any) => part.text)?.filter((text: any) => text)?.join("\n\n") ?? "";
      if (["aimlapi", "pollinations", "moonshot", "cometapi", "chutes", "electronhub", "nanogpt", "siliconflow", "zai", "workers_ai", "fireworks", "custom"].includes(source)) return message?.reasoning_content ?? message?.reasoning ?? "";
      return "";
    },
  };
  Object.defineProperty(reasoning, "initialize", { value: async () => { reasoningSettings = await host.request("reasoning.settings", {}); } });
  Object.defineProperty(reasoning, "getMainApi", { value: () => {
    if (!reasoningSettings) return unsupported("main_api (reasoning settings are not loaded)");
    return reasoningSettings.mainApi;
  } });
  // Intentional client approximation: JS string length (UTF-16 code units),
  // rather than upstream's UTF-8 byte count or a model tokenizer service.
  const CHARACTERS_PER_TOKEN_RATIO = 3.35;
  const guesstimate = (text: string) => typeof text === "string" ? Math.ceil(text.length / CHARACTERS_PER_TOKEN_RATIO) : 0;
  const getTokenCount = (text: string, padding = 0) => {
    if (typeof text !== "string" || !text.length) return 0;
    if (typeof padding !== "number" || !Number.isFinite(padding)) throw new TypeError("Token padding must be a finite number.");
    return guesstimate(text) + padding;
  };
  class Prompt {
    [key: string]: any;
    enabled: any; marker: any;
    constructor(props: any = {}) {
      for (const key of ["identifier", "role", "content", "name", "system_prompt", "position", "injection_depth", "injection_position", "forbid_overrides"]) this[key] = props[key];
      this.extension = props.extension ?? false;
      this.injection_order = props.injection_order ?? 100;
      this.injection_trigger = props.injection_trigger ?? [];
    }
  }
  class PromptCollection {
    collection: Prompt[] = [];
    overriddenPrompts: string[] = [];
    constructor(...prompts: Prompt[]) { this.add(...prompts); }
    checkPromptInstance(...prompts: Prompt[]) {
      for (const prompt of prompts) if (!(prompt instanceof Prompt)) throw Error("Only Prompt instances can be added to PromptCollection");
    }
    add(...prompts: Prompt[]) { this.checkPromptInstance(...prompts); this.collection.push(...prompts); }
    set(prompt: Prompt, position: number) { this.checkPromptInstance(prompt); this.collection[position] = prompt; }
    get(identifier: string) { return this.collection.find(prompt => prompt.identifier === identifier); }
    index(identifier: string) { return this.collection.findIndex(prompt => prompt.identifier === identifier); }
    has(identifier: string) { return this.index(identifier) !== -1; }
    override(prompt: Prompt, position: number) { this.set(prompt, position); this.overriddenPrompts.push(prompt.identifier); }
  }
  class SlashCommandEnumValue {
    constructor(public value: string, public description: string | null = null, public type: string | null = "enum", public typeIcon = "◊", public matchProvider: any = null, public valueProvider: any = null, public makeSelectable = false) { this.type = type ?? "enum"; }
    toString() { return this.value; }
  }
  const enumTypes: any = Object.fromEntries(["enum", "command", "namedArgument", "variable", "qr", "macro", "number", "name"].map(key => [key, key]));
  enumTypes.getBasedOnIndex = function(index: number) { const keys = Object.keys(this); return this[keys[(index ?? 0) % keys.length]]; };
  const enumIcons: any = {
    default: "◊", variable: "𝑥", localVariable: "L", globalVariable: "G", scopeVariable: "S", character: "👤", group: "🧑‍🤝‍🧑", persona: "🧙‍♂️", qr: "QR", closure: "𝑓", macro: "{{", tag: "🏷️", world: "🌐", preset: "⚙️", file: "📄", message: "💬", reasoning: "💡", voice: "🎤", server: "🖥️", popup: "🗔", image: "🖼️", video: "🎥", key: "🔑", spinner: "♻️", stop: "🛑", true: "✔️", false: "❌", null: "🚫", undefined: "❓", boolean: "🔲", string: "📝", number: "1️⃣", array: "[]", enum: "📚", dictionary: "{}", system: "⚙️", user: "👤", assistant: "🤖", constant: "🔵", normal: "🟢", disabled: "❌", vectorized: "🔗",
    getStateIcon: (state: boolean) => state ? enumIcons.true : enumIcons.false,
    getWiStatusIcon: (entry: any) => entry.constant ? enumIcons.constant : entry.disable ? enumIcons.disabled : entry.vectorized ? enumIcons.vectorized : enumIcons.normal,
    getRoleIcon: (role: number) => ({ 0: enumIcons.system, 1: enumIcons.user, 2: enumIcons.assistant })[role] ?? enumIcons.default,
    getDataTypeIcon: (type: string) => enumIcons[type.replace(/\?$/, "")] ?? enumIcons.default,
  };
  const commonEnumProviders: any = {
    boolean: (mode = "trueFalse") => () => {
      const values: Record<string, string[]> = { trueFalse: ["true", "false"], onOff: ["on", "off"], onOffToggle: ["on", "off", "toggle"] };
      if (!values[mode]) throw Error(`Invalid boolean enum provider mode: ${mode}`);
      return values[mode].map((value, index) => new SlashCommandEnumValue(value, null, "macro", [enumIcons.true, enumIcons.false, enumIcons.boolean][index]));
    },
    types: () => ["string", "number", "boolean", "array", "object", "null", "undefined"].map(type => new SlashCommandEnumValue(type, null, undefined, enumIcons[type === "object" ? "dictionary" : type])),
    messageRoles: () => ["user", "assistant", "system"].map(role => new SlashCommandEnumValue(role, null, "enum", enumIcons[role])),
  };
  // Provider factories may be registered before a chat exists. Resolve the
  // unsupported state only when invoked; never advertise an empty catalog.
  for (const name of ["variables", "characters", "groupMembers", "personas", "tags", "tagsForChar", "messages", "messageMedia", "connectionProfiles"]) commonEnumProviders[name] = () => () => unsupported(`commonEnumProviders.${name}`);
  for (const name of ["numbersAndVariables", "messageNames", "worlds", "injects", "backgrounds"]) commonEnumProviders[name] = () => unsupported(`commonEnumProviders.${name}`);
  const ARGUMENT_TYPE = { STRING: "string", NUMBER: "number", RANGE: "range", BOOLEAN: "bool", VARIABLE_NAME: "varname", CLOSURE: "closure", SUBCOMMAND: "subcommand", LIST: "list", DICTIONARY: "dictionary" };
  class SlashCommandArgument {
    typeList: string[]; enumList: SlashCommandEnumValue[];
    constructor(public description: string, types: string | string[], public isRequired = false, public acceptsMultiple = false, public defaultValue: any = null, enums: any = [], public enumProvider: any = null, public forceEnum = false) {
      this.typeList = types ? Array.isArray(types) ? types : [types] : [];
      this.isRequired = isRequired ?? false; this.acceptsMultiple = acceptsMultiple ?? false;
      this.enumList = (enums ? Array.isArray(enums) ? enums : [enums] : []).map((item: any) => item instanceof SlashCommandEnumValue ? item : new SlashCommandEnumValue(item));
      if (!this.enumList.length && this.typeList.length === 1 && this.typeList.includes(ARGUMENT_TYPE.BOOLEAN)) this.enumList = commonEnumProviders.boolean()();
    }
    static fromProps(p: any): SlashCommandArgument { return new SlashCommandArgument(p.description, p.typeList ?? [ARGUMENT_TYPE.STRING], p.isRequired ?? false, p.acceptsMultiple ?? false, p.defaultValue ?? null, p.enumList ?? [], p.enumProvider ?? null, p.forceEnum ?? false); }
  }
  class SlashCommandNamedArgument extends SlashCommandArgument {
    aliasList: string[];
    constructor(public name: string, description: string, types: string | string[], isRequired = false, acceptsMultiple = false, defaultValue: any = null, enums: any = [], aliases: string | string[] = [], enumProvider: any = null, forceEnum = false) {
      super(description, types, isRequired, acceptsMultiple, defaultValue, enums, enumProvider, forceEnum);
      this.aliasList = aliases ? Array.isArray(aliases) ? aliases : [aliases] : [];
    }
    static fromProps(p: any) { return new SlashCommandNamedArgument(p.name, p.description, p.typeList ?? [ARGUMENT_TYPE.STRING], p.isRequired ?? false, p.acceptsMultiple ?? false, p.defaultValue ?? null, p.enumList ?? [], p.aliasList ?? [], p.enumProvider ?? null, p.forceEnum ?? false); }
  }
  class SlashCommand {
    [key: string]: any;
    name!: string; callback!: (...args: any[]) => any;
    splitUnnamedArgument = false; rawQuotes = false; aliases: string[] = [];
    namedArgumentList: SlashCommandNamedArgument[] = []; unnamedArgumentList: SlashCommandArgument[] = [];
    helpCache = {}; helpDetailsCache = {}; isExtension = false; isThirdParty = false;
    static fromProps(props: any) { return Object.assign(new this(), props); }
    renderHelpItem() { return unsupported("SlashCommand.renderHelpItem"); }
    renderHelpDetails() { return unsupported("SlashCommand.renderHelpDetails"); }
  }
  class SlashCommandParser {
    static commands: Record<string, SlashCommand> = Object.create(null);
    get commands() { return SlashCommandParser.commands; }
    static addCommand(name: string, callback: any, aliases: string[] = [], helpString = "") { this.addCommandObject(SlashCommand.fromProps({ name, callback, aliases, helpString })); }
    static addCommandObject(command: SlashCommand) {
      for (const prefix of ["/", "#", ":", "parser-flag", "breakpoint"]) {
        if ([command.name, ...(command.aliases ?? [])].some(name => name.toLowerCase().startsWith(prefix))) throw Error(`Illegal Name. Slash command name cannot begin with "${prefix}".`);
      }
      this.addCommandObjectUnsafe(command);
    }
    static addCommandObjectUnsafe(command: SlashCommand) {
      command.isExtension = true; command.isThirdParty = host.thirdParty; command.source = host.extensionName;
      for (const name of [command.name, ...command.aliases]) this.commands[name] = command;
    }
    parse() { return unsupported("SlashCommandParser.parse (STscript execution)"); }
  }
  const executeSlashCommandsWithOptions = () => unsupported("executeSlashCommandsWithOptions (STscript execution)");

  // Upstream sse-stream.js EventSourceStream: byte decoding, multiline payloads,
  // sticky IDs and completed-event boundaries. EOF never dispatches an unfinished event.
  class EventSourceStream {
    readable: ReadableStream; writable: WritableStream;
    constructor() {
      const decoder = new w.TextDecoderStream("utf-8");
      let buffer = "", lastEventId = "";
      const parser = new w.TransformStream({ transform(chunk: string, controller: TransformStreamDefaultController) {
        buffer += chunk;
        const chunks = buffer.split(/\r\n\r\n|\r\r|\n\n/g); buffer = chunks.pop()!;
        for (const chunk of chunks) {
          let eventType = "", data = "";
          for (const line of chunk.split(/\n|\r|\r\n/g)) {
            const match = /([^:]+)(?:: ?(.*))?/.exec(line);
            if (!match) continue;
            const [, field, value = ""] = match;
            if (field === "event") eventType = value;
            if (field === "data") data += `${value}\n`;
            if (field === "id" && !value.includes("\0")) lastEventId = value;
          }
          if (data !== "") controller.enqueue(new w.MessageEvent(eventType || "message", { data: data.slice(0, -1), lastEventId }));
        }
      } });
      this.readable = decoder.readable.pipeThrough(parser); this.writable = decoder.writable;
    }
  }
  let worldSnapshot: { names: string[]; selected: string[]; settings: Record<string, any> } | undefined;
  const worldState = () => {
    if (!worldSnapshot) return unsupported("World Info settings (catalog snapshot is not loaded)");
    return worldSnapshot;
  };
  const worldClone = (value: any) => JSON.parse(JSON.stringify(value));
  const newWorldInfoEntryDefinition: Record<string, any> = {
    key: { default: [], type: "array" }, keysecondary: { default: [], type: "array" },
    comment: { default: "", type: "string" }, content: { default: "", type: "string" },
    constant: { default: false, type: "boolean" }, vectorized: { default: false, type: "boolean" },
    selective: { default: true, type: "boolean" }, selectiveLogic: { default: 0, type: "enum" },
    addMemo: { default: false, type: "boolean" }, order: { default: 100, type: "number" }, position: { default: 0, type: "number" },
    disable: { default: false, type: "boolean" }, ignoreBudget: { default: false, type: "boolean" },
    excludeRecursion: { default: false, type: "boolean" }, preventRecursion: { default: false, type: "boolean" },
    matchPersonaDescription: { default: false, type: "boolean" }, matchCharacterDescription: { default: false, type: "boolean" },
    matchCharacterPersonality: { default: false, type: "boolean" }, matchCharacterDepthPrompt: { default: false, type: "boolean" },
    matchScenario: { default: false, type: "boolean" }, matchCreatorNotes: { default: false, type: "boolean" },
    delayUntilRecursion: { default: 0, type: "number" }, probability: { default: 100, type: "number" },
    useProbability: { default: true, type: "boolean" }, depth: { default: 4, type: "number" },
    outletName: { default: "", type: "string" }, group: { default: "", type: "string" },
    groupOverride: { default: false, type: "boolean" }, groupWeight: { default: 100, type: "number" },
    scanDepth: { default: null, type: "number?" }, caseSensitive: { default: null, type: "boolean?" },
    matchWholeWords: { default: null, type: "boolean?" }, useGroupScoring: { default: null, type: "boolean?" },
    automationId: { default: "", type: "string" }, role: { default: 0, type: "enum" },
    sticky: { default: null, type: "number?" }, cooldown: { default: null, type: "number?" }, delay: { default: null, type: "number?" },
    characterFilterNames: { default: [], type: "array", excludeFromTemplate: true },
    characterFilterTags: { default: [], type: "array", excludeFromTemplate: true },
    characterFilterExclude: { default: false, type: "boolean", excludeFromTemplate: true },
    triggers: { default: [], type: "array", arrayFilter: (value: string) => constants.GENERATION_TYPE_TRIGGERS.includes(value) },
  };
  const newWorldInfoEntryTemplate = Object.fromEntries(Object.entries(newWorldInfoEntryDefinition).filter(([, value]) => !value.excludeFromTemplate).map(([key, value]) => [key, value.default]));
  const worldInfo: Record<string, any> = {
    DEFAULT_DEPTH: 4, DEFAULT_WEIGHT: 100, MAX_SCAN_DEPTH: 1000, METADATA_KEY: "world_info",
    SORT_ORDER_KEY: "world_info_sort_order", scan_state: { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 },
    world_info_position: { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 },
    wi_anchor_position: { before: 0, after: 1 },
    world_info_logic: { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 },
    world_info_insertion_strategy: { evenly: 0, character_first: 1, global_first: 2 },
    parseRegexFromString: (input: string) => {
      const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
      if (!match || match[1].match(/(^|[^\\])\//)) return null;
      try { return new RegExp(match[1].replace("\\/", "/"), match[2]); } catch { return null; }
    },
    loadWorldInfo: async (name: string) => name ? host.request("worldInfo.load", { name }) : undefined,
    get world_info() { return worldClone(worldState().settings.world_info); },
    get selected_world_info() { return [...worldState().selected]; },
    get world_names() { return [...worldState().names]; },
    getWorldInfoSettings: () => worldClone(worldState().settings),
    newWorldInfoEntryDefinition, newWorldInfoEntryTemplate,
    convertCharacterBook(characterBook: any) {
      const result = { entries: {} as Record<string, any>, originalData: characterBook };
      characterBook.entries.forEach((entry: any, index: number) => {
        if (entry.id === undefined) entry.id = index;
        const converted = {
          ...newWorldInfoEntryTemplate, uid: entry.id, key: entry.keys, keysecondary: entry.secondary_keys || [],
          comment: entry.comment || "", content: entry.content, constant: entry.constant || false,
          selective: entry.selective || false, order: entry.insertion_order,
          position: entry.extensions?.position ?? (entry.position === "before_char" ? 0 : 1),
          excludeRecursion: entry.extensions?.exclude_recursion ?? false, preventRecursion: entry.extensions?.prevent_recursion ?? false,
          delayUntilRecursion: entry.extensions?.delay_until_recursion ?? false, disable: !entry.enabled, addMemo: !!entry.comment,
          displayIndex: entry.extensions?.display_index ?? index, probability: entry.extensions?.probability ?? 100,
          useProbability: entry.extensions?.useProbability ?? true, depth: entry.extensions?.depth ?? 4,
          selectiveLogic: entry.extensions?.selectiveLogic ?? 0, outletName: entry.extensions?.outlet_name ?? "",
          group: entry.extensions?.group ?? "", groupOverride: entry.extensions?.group_override ?? false,
          groupWeight: entry.extensions?.group_weight ?? 100, scanDepth: entry.extensions?.scan_depth ?? null,
          caseSensitive: entry.extensions?.case_sensitive ?? null, matchWholeWords: entry.extensions?.match_whole_words ?? null,
          useGroupScoring: entry.extensions?.use_group_scoring ?? null, automationId: entry.extensions?.automation_id ?? "",
          role: entry.extensions?.role ?? 0, vectorized: entry.extensions?.vectorized ?? false,
          sticky: entry.extensions?.sticky ?? null, cooldown: entry.extensions?.cooldown ?? null, delay: entry.extensions?.delay ?? null,
          matchPersonaDescription: entry.extensions?.match_persona_description ?? false,
          matchCharacterDescription: entry.extensions?.match_character_description ?? false,
          matchCharacterPersonality: entry.extensions?.match_character_personality ?? false,
          matchCharacterDepthPrompt: entry.extensions?.match_character_depth_prompt ?? false,
          matchScenario: entry.extensions?.match_scenario ?? false, matchCreatorNotes: entry.extensions?.match_creator_notes ?? false,
          extensions: entry.extensions ?? {}, triggers: entry.extensions?.triggers || [], ignoreBudget: entry.extensions?.ignore_budget ?? false,
        };
        // Preserve source IDs/aliasing without invoking Object.prototype's
        // __proto__ setter on extension-provided data.
        Object.defineProperty(result.entries, entry.id, { value: converted, enumerable: true, configurable: true, writable: true });
      });
      return result;
    },
  };
  const worldSettingDefaults: Record<string, number | boolean> = {
    world_info_depth: 2, world_info_min_activations: 0, world_info_min_activations_depth_max: 0,
    world_info_include_names: true, world_info_recursive: false, world_info_case_sensitive: false,
    world_info_match_whole_words: false, world_info_use_group_scoring: false,
    world_info_character_strategy: 1, world_info_max_recursion_steps: 0,
  };
  for (const key of Object.keys(worldSettingDefaults)) Object.defineProperty(worldInfo, key, { enumerable: true, get: () => worldState().settings[key] ?? worldSettingDefaults[key] });
  for (const name of ["saveWorldInfo", "deleteWorldInfo", "createNewWorldInfo", "getWorldInfoPrompt", "getSortedEntries", "checkWorldInfo", "updateWorldInfoList"]) worldInfo[name] = async () => unsupported(`${name} (native revision, reference or scan lifecycle is not bound)`);
  for (const name of ["setWorldInfoButtonClass", "setWorldInfoSettings", "updateWorldInfoSettings", "initWorldInfo"]) worldInfo[name] = () => unsupported(`${name} (native World Info settings/UI lifecycle is not bound)`);
  Object.defineProperty(worldInfo, "initialize", { value: async () => {
    const value = await host.request("worldInfo.snapshot", {});
    worldSnapshot = { ...value, settings: { ...worldSettingDefaults, ...value.settings } };
  } });
  return {
    "/scripts/macros.js": macros,
    "/scripts/user.js": user,
    "/scripts/authors-note.js": authorsNote,
    "/scripts/constants.js": constants,
    "/scripts/RossAscends-mods.js": ross,
    "/scripts/power-user.js": {
      persona_description_positions,
      MAX_CONTEXT_DEFAULT: 8192, MAX_RESPONSE_DEFAULT: 2048,
      chat_styles: { DEFAULT: 0, BUBBLES: 1, DOCUMENT: 2 },
      send_on_enter_options: { DISABLED: -1, AUTO: 0, ENABLED: 1 },
      power_user: new Proxy({}, { get: (_target, name) => unsupported(`power_user.${String(name)}`), set: (_target, name) => unsupported(`power_user.${String(name)} write`) }),
      addEphemeralStoppingString: () => unsupported("addEphemeralStoppingString (generation stopping state)"),
      flushEphemeralStoppingStrings: () => unsupported("flushEphemeralStoppingStrings (generation stopping state)"),
    },
    "/scripts/personas.js": personas,
    "/scripts/reasoning.js": reasoning,
    "/scripts/tokenizers.js": {
      CHARACTERS_PER_TOKEN_RATIO, BYTES_PER_TOKEN: CHARACTERS_PER_TOKEN_RATIO,
      guesstimate, getTokenCount,
      getTokenCountAsync: async (text: string, padding?: number) => getTokenCount(text, padding),
    },
    "/scripts/PromptManager.js": { Prompt, PromptCollection, INJECTION_POSITION: { RELATIVE: 0, ABSOLUTE: 1 } },
    "/scripts/slash-commands/SlashCommand.js": { SlashCommand },
    "/scripts/slash-commands/SlashCommandArgument.js": { SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE },
    "/scripts/slash-commands/SlashCommandEnumValue.js": { SlashCommandEnumValue, enumTypes },
    "/scripts/slash-commands/SlashCommandCommonEnumsProvider.js": { enumIcons, commonEnumProviders, commonEnumMatchProviders: { folderEnum: (input: string, check: string, { trueOnEmpty = true } = {}) => !check ? false : !input ? trueOnEmpty : input.toLowerCase().startsWith(check.toLowerCase()) || check.toLowerCase().startsWith(input.toLowerCase()) } },
    "/scripts/slash-commands/SlashCommandParser.js": { SlashCommandParser, PARSER_FLAG: { STRICT_ESCAPING: 1, REPLACE_GETVAR: 2 } },
    "/scripts/slash-commands.js": { executeSlashCommandsWithOptions },
    "/scripts/sse-stream.js": { default: EventSourceStream, getEventSourceStream: () => new EventSourceStream() },
    "/scripts/world-info.js": worldInfo,
  };
}
