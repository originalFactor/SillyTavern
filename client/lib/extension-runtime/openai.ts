// Source-derived pure interfaces from STOriginal/public/scripts/openai.js.
// Serialized into the opaque frame; keep dependencies and state inside here.
export function installExtensionOpenAI(_w: any, host: any) {
  const { unsupported } = host;
  const blocked = (name: string) => (..._args: any[]) => unsupported(name);
  const sources = {
    OPENAI: "openai", CLAUDE: "claude", OPENROUTER: "openrouter", AI21: "ai21", MAKERSUITE: "makersuite", VERTEXAI: "vertexai",
    MISTRALAI: "mistralai", CUSTOM: "custom", COHERE: "cohere", PERPLEXITY: "perplexity", GROQ: "groq", ELECTRONHUB: "electronhub",
    CHUTES: "chutes", NANOGPT: "nanogpt", DEEPSEEK: "deepseek", AIMLAPI: "aimlapi", XAI: "xai", POLLINATIONS: "pollinations",
    MOONSHOT: "moonshot", FIREWORKS: "fireworks", COMETAPI: "cometapi", AZURE_OPENAI: "azure_openai", ZAI: "zai",
    SILICONFLOW: "siliconflow", WORKERS_AI: "workers_ai", MINIMAX: "minimax",
  };
  const modelFields: Record<string, string> = Object.fromEntries(Object.values(sources).map(source => [source, `${source}_model`]));
  modelFields.makersuite = "google_model";
  let settings: Record<string, string | boolean | number> | undefined;
  const requireSettings = () => {
    if (!settings) return unsupported("openai settings (safe settings snapshot is not loaded)");
    return settings;
  };
  const readOnly = (target: any, label: string) => new Proxy(target, {
    get(object, key) {
      if (typeof key === "symbol") return Reflect.get(object, key);
      if (Object.hasOwn(object, key)) return object[key];
      return unsupported(`${label}.${key}`);
    },
    set: (_object, key) => unsupported(`${label}.${String(key)} write`),
    defineProperty: (_object, key) => unsupported(`${label}.${String(key)} define`),
    deleteProperty: (_object, key) => unsupported(`${label}.${String(key)} delete`),
    setPrototypeOf: () => unsupported(`${label} prototype write`),
    preventExtensions: () => unsupported(`${label} preventExtensions`),
  });
  // No connection URLs, credentials, headers, prompt settings or proxy presets.
  const settingsTarget = Object.create(null);
  for (const key of ["chat_completion_source", "show_thoughts", "openai_max_context", "openai_max_tokens", ...Object.values(modelFields)]) Object.defineProperty(settingsTarget, key, { enumerable: true, get: () => requireSettings()[key] });
  const oai_settings = readOnly(settingsTarget, "oai_settings");
  const getChatCompletionModel = (explicit: any = null) => {
    const value = explicit ?? requireSettings();
    const source = value.chat_completion_source;
    const field = Object.hasOwn(modelFields, source) ? modelFields[source] : undefined;
    if (!field) return "";
    const model = value[field];
    return source === "openrouter" && model === "OR_Website" ? null : model;
  };
  class TokenHandler {
    counts: Record<string, number> = { start_chat: 0, prompt: 0, bias: 0, nudge: 0, jailbreak: 0, impersonate: 0, examples: 0, conversation: 0 };
    constructor(public countTokenAsyncFn: (messages: any, full?: boolean) => Promise<number>) {}
    getCounts() { return this.counts; }
    resetCounts() { Object.keys(this.counts).forEach(key => this.counts[key] = 0); }
    setCounts(counts: Record<string, number>) { this.counts = counts; }
    uncount(value: number, type: string) { this.counts[type] -= value; }
    async countAsync(messages: any, full?: boolean, type?: string) {
      const count = await this.countTokenAsyncFn(messages, full);
      this.counts[String(type)] += count;
      return count;
    }
    getTokensForIdentifier(identifier: string) { return this.counts[identifier] ?? 0; }
    getTotal() { return Object.values(this.counts).reduce((sum, count) => sum + (isNaN(count) ? 0 : count), 0); }
    log() { console.table({ ...this.counts, total: this.getTotal() }); }
  }
  // Explicit approximation shared with tokenizers.js; never used by native
  // generation or reported as provider usage. No tokenization service is called.
  const tokenHandler = new TokenHandler(async message => host.countText(JSON.stringify(message)));
  class IdentifierNotFoundError extends Error {
    constructor(identifier: string) { super(`Identifier ${identifier} not found.`); this.name = "IdentifierNotFoundError"; }
  }
  class TokenBudgetExceededError extends Error {
    constructor(identifier = "") { super(`Token budged exceeded. Message: ${identifier}`); this.name = "TokenBudgetExceeded"; }
  }
  class Message {
    static tokensPerImage = 85;
    tokens = 0;
    name?: string;
    tool_call = null;
    tool_calls?: any[];
    signature: string | null = null;
    reasoning: string | null = null;
    constructor(public role: string, public content: any, public identifier: string) { this.role ||= "system"; }
    static async createAsync(role: string, content: any, identifier: string) {
      const message = new Message(role, content, identifier);
      if (typeof content === "string" && content.length) message.tokens = await tokenHandler.countAsync({ role: message.role, content });
      return message;
    }
    static fromPromptAsync(prompt: any) { return Message.createAsync(prompt.role, prompt.content, prompt.identifier); }
    async setToolCalls(invocations: any[], includeSignature: boolean, includeReasoning = false) {
      this.tool_calls = invocations.map(i => ({ id: i.id, type: "function", function: { arguments: i.parameters, name: i.name }, ...(includeSignature && i.signature ? { signature: i.signature } : {}) }));
      const reasoning = invocations.find(i => typeof i.reasoning === "string" && i.reasoning.length > 0)?.reasoning || null;
      this.reasoning = includeReasoning ? reasoning : null;
      this.tokens = await tokenHandler.countAsync({ role: this.role, tool_calls: JSON.stringify(this.tool_calls), ...(this.reasoning ? { reasoning: this.reasoning } : {}) });
    }
    async setName(name: string) {
      this.name = name;
      this.tokens = await tokenHandler.countAsync({ role: this.role, content: this.content, name });
    }
    ensureContentIsArray() {
      if (!Array.isArray(this.content)) this.content = typeof this.content === "string" ? [{ type: "text", text: this.content }] : [];
      return this.content;
    }
    async addImage(_image: string) { return unsupported("Message.addImage (media input is not supported)"); }
    async addVideo(_video: string) { return unsupported("Message.addVideo (media input is not supported)"); }
    async addAudio(_audio: string) { return unsupported("Message.addAudio (media input is not supported)"); }
    async compressImage(_image: string) { return unsupported("Message.compressImage (media processing is not bound)"); }
    async getImageTokenCost(_image: string, _quality: string) { return unsupported("Message.getImageTokenCost (model media tokenization is not supported)"); }
    getTokens() { return this.tokens; }
  }
  const asChatMessage = (message: Message) => ({
    role: message.role, content: message.content,
    ...(message.name && { name: message.name }), ...(message.tool_calls && { tool_calls: message.tool_calls }),
    ...(message.role === "tool" && { tool_call_id: message.identifier }),
    ...(message.signature && { signature: message.signature }), ...(message.reasoning && { reasoning: message.reasoning }),
  });
  class MessageCollection {
    collection: (Message | MessageCollection)[] = [];
    constructor(public identifier: string, ...items: (Message | MessageCollection)[]) {
      for (const item of items) if (!(item instanceof Message || item instanceof MessageCollection)) throw Error("Only Message and MessageCollection instances can be added to MessageCollection");
      this.collection.push(...items);
    }
    // Upstream getChat is intentionally shallow; flatten is a separate method.
    getChat() { return this.collection.filter((message: any) => message.content || message.tool_calls).map(message => asChatMessage(message as Message)); }
    getCollection() { return this.collection; }
    add(item: Message | MessageCollection) { this.collection.push(item); }
    getItemByIdentifier(identifier: string) { return this.collection.find(item => item?.identifier === identifier); }
    hasItemWithIdentifier(identifier: string) { return this.collection.some(item => item.identifier === identifier); }
    getTokens(): number { return this.collection.reduce((tokens, message) => tokens + message.getTokens(), 0); }
    flatten(): Message[] { return this.collection.reduce<Message[]>((all, message) => { all.push(...(message instanceof MessageCollection ? message.flatten() : [message])); return all; }, []); }
  }
  class ChatCompletion {
    tokenBudget = 0;
    messages = new MessageCollection("root");
    loggingEnabled = false;
    overriddenPrompts: string[] = [];
    getMessages() { return this.messages; }
    setTokenBudget(context: number, response: number) { this.tokenBudget = context - response; }
    add(collection: MessageCollection, position: number | null = null) {
      this.validateMessageCollection(collection); this.checkTokenBudget(collection, collection.identifier);
      if (position !== null && position !== -1) this.messages.collection[position] = collection;
      else this.messages.collection.push(collection);
      this.decreaseTokenBudgetBy(collection.getTokens());
      return this;
    }
    insertAtStart(message: Message, identifier: string) { this.insert(message, identifier, "start"); }
    insertAtEnd(message: Message, identifier: string) { this.insert(message, identifier, "end"); }
    insert(message: Message, identifier: string, position: string | number = "end") {
      this.validateMessage(message); this.checkTokenBudget(message, message.identifier);
      const target = this.messages.collection[this.findMessageIndex(identifier)] as MessageCollection;
      if (message.content || message.tool_calls) {
        if (position === "start") target.collection.unshift(message);
        else if (position === "end") target.collection.push(message);
        else if (typeof position === "number") target.collection.splice(position, 0, message);
        this.decreaseTokenBudgetBy(message.getTokens());
      }
    }
    removeLastFrom(identifier: string) {
      const message = (this.messages.collection[this.findMessageIndex(identifier)] as MessageCollection).collection.pop();
      if (message) this.increaseTokenBudgetBy(message.getTokens());
    }
    canAfford(message: Message | MessageCollection) { return this.tokenBudget - message.getTokens() >= 0; }
    canAffordAll(messages: Message[]) { return this.tokenBudget - messages.reduce((sum, message) => sum + message.getTokens(), 0) >= 0; }
    has(identifier: string) { return this.messages.hasItemWithIdentifier(identifier); }
    getTotalTokenCount() { return this.messages.getTokens(); }
    getChat() {
      const chat: any[] = [];
      for (const item of this.messages.collection) {
        if (item instanceof MessageCollection) chat.push(...item.getChat());
        else if (item instanceof Message && (item.content || item.tool_calls)) chat.push(asChatMessage(item));
      }
      return chat;
    }
    log(output: string) { if (this.loggingEnabled) console.log("[ChatCompletion] " + output); }
    enableLogging() { this.loggingEnabled = true; }
    disableLogging() { this.loggingEnabled = false; }
    validateMessageCollection(collection: any) { if (!(collection instanceof MessageCollection)) throw Error("Argument must be an instance of MessageCollection"); }
    validateMessage(message: any) { if (!(message instanceof Message)) throw Error("Argument must be an instance of Message"); }
    checkTokenBudget(message: Message | MessageCollection, identifier: string) { if (!this.canAfford(message)) throw new TokenBudgetExceededError(identifier); }
    reserveBudget(message: Message | MessageCollection | number) { this.decreaseTokenBudgetBy(typeof message === "number" ? message : message.getTokens()); }
    freeBudget(message: Message | MessageCollection) { this.increaseTokenBudgetBy(message.getTokens()); }
    increaseTokenBudgetBy(tokens: number) { this.tokenBudget += tokens; }
    decreaseTokenBudgetBy(tokens: number) { this.tokenBudget -= tokens; }
    findMessageIndex(identifier: string) {
      const index = this.messages.collection.findIndex(item => item?.identifier === identifier);
      if (index < 0) throw new IdentifierNotFoundError(identifier);
      return index;
    }
    setOverriddenPrompts(list: string[]) { this.overriddenPrompts = list; }
    getOverriddenPrompts() { return this.overriddenPrompts ?? []; }
    async squashSystemMessages() {
      const shouldSquash = (message: Message) => !["newMainChat", "newChat", "groupNudge"].includes(message.identifier) && message.role === "system" && !message.name;
      this.messages.collection = this.messages.flatten();
      const squashed: Message[] = [];
      let last: Message | undefined;
      for (const message of this.messages.collection as Message[]) {
        if (message.role === "system" && !message.content) continue;
        if (shouldSquash(message) && last && shouldSquash(last)) {
          last.content += "\n" + message.content;
          last.tokens = await tokenHandler.countAsync({ role: last.role, content: last.content });
        } else { squashed.push(message); last = message; }
      }
      this.messages.collection = squashed;
    }
  }
  const openaiModule = {
    Message, MessageCollection, ChatCompletion, TokenHandler, IdentifierNotFoundError,
    chat_completion_sources: sources, oai_settings, getChatCompletionModel,
    custom_prompt_post_processing_types: { NONE: "", CLAUDE: "claude", MERGE: "merge", MERGE_TOOLS: "merge_tools", SEMI: "semi", SEMI_TOOLS: "semi_tools", STRICT: "strict", STRICT_TOOLS: "strict_tools", SINGLE: "single" },
    reasoning_effort_types: { auto: "auto", low: "low", medium: "medium", high: "high", min: "min", max: "max" },
    verbosity_levels: { auto: "auto", low: "low", medium: "medium", high: "high" },
    tool_reasoning_modes: { DISABLED: "disabled", SINCE_LAST_USER: "since_last_user", ACTIVE_CHAIN: "active_chain" },
    ZAI_ENDPOINT: { COMMON: "common", CODING: "coding" }, POLLINATIONS_ENDPOINT: { AUTHENTICATED: "authenticated", ANONYMOUS: "anonymous" },
    SILICONFLOW_ENDPOINT: { GLOBAL: "global", CN: "cn" }, MINIMAX_ENDPOINT: { GLOBAL: "global", CN: "cn" },
    getPromptPosition: (position: number) => position == 2 ? "start" : position == 0 ? "end" : false,
    getPromptRole: (role: number) => role === 1 ? "user" : role === 2 ? "assistant" : "system",
    isImageInliningSupported: () => false, isVideoInliningSupported: () => false, isAudioInliningSupported: () => false,
    promptManager: readOnly({ render: blocked("promptManager.render"), renderDebounced: blocked("promptManager.renderDebounced") }, "promptManager"),
    proxies: readOnly(Object.create(null), "proxies (proxy presets are private)"),
    prepareOpenAIMessages: async (..._args: any[]) => unsupported("prepareOpenAIMessages (native prompt preparation is not bound)"),
    sendOpenAIRequest: async (..._args: any[]) => unsupported("sendOpenAIRequest (native generation admission is required)"),
    setOpenAIMessages: blocked("setOpenAIMessages (chat state is not bound)"),
    setOpenAIMessageExamples: blocked("setOpenAIMessageExamples (chat state is not bound)"),
    setupChatCompletionPromptManager: blocked("setupChatCompletionPromptManager (upstream prompt manager UI)"),
    loadOpenAISettings: blocked("loadOpenAISettings (provider settings writes are not exposed)"),
    getStreamingReply(data: any, state: any, { chatCompletionSource = null, overrideShowThoughts = null }: any = {}) {
      const source = chatCompletionSource ?? requireSettings().chat_completion_source;
      const thoughts = overrideShowThoughts ?? requireSettings().show_thoughts;
      if (source === "claude") {
        if (thoughts) state.reasoning += data?.delta?.thinking || "";
        return data?.delta?.text || "";
      }
      if (["makersuite", "vertexai"].includes(source)) {
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const inline = parts.filter((part: any) => part.inlineData && !part.thought).map((part: any) => part.inlineData);
        if (inline.length > 0) state.images.push(...inline.map((image: any) => `data:${image.mimeType};base64,${image.data}`).filter(host.isDataURL));
        if (thoughts) state.reasoning += parts.filter((part: any) => part.thought).map((part: any) => part.text)[0] || "";
        for (const part of parts) if (part.thoughtSignature && typeof part.text === "string") state.signature = part.thoughtSignature;
        return parts.filter((part: any) => !part.thought).map((part: any) => part.text)[0] || "";
      }
      if (source === "cohere") return data?.delta?.message?.content?.text || data?.delta?.message?.tool_plan || "";
      if (["deepseek", "xai"].includes(source)) {
        if (thoughts) state.reasoning += data.choices?.filter((item: any) => item?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content || "";
        return data.choices?.[0]?.delta?.content || "";
      }
      if (source === "openrouter") {
        const urls = data?.choices?.[0]?.delta?.images?.filter((item: any) => item.type === "image_url")?.map((item: any) => item?.image_url?.url) || [];
        if (urls.length > 0) state.images.push(...urls.filter(host.isDataURL));
        if (thoughts) state.reasoning += data.choices?.find((item: any) => item?.delta?.reasoning)?.delta.reasoning ?? data.choices?.find((item: any) => item?.delta?.reasoning_content)?.delta.reasoning_content ?? data.choices?.find((item: any) => item?.message?.reasoning)?.message.reasoning ?? data.choices?.find((item: any) => item?.message?.reasoning_content)?.message.reasoning_content ?? "";
        const details = [...(data?.choices?.[0]?.delta?.reasoning_details || []), ...(data?.choices?.[0]?.message?.reasoning_details || [])];
        for (const detail of details) if (detail.type === "reasoning.encrypted" && detail.data) {
          const toolId = typeof detail.id === "string" && /^(tool_|call_)/.test(detail.id);
          if (typeof detail.id === "string" && detail.id.length > 0) state.toolSignatures[detail.id] = detail.data;
          if (!toolId) state.signature = detail.data;
        }
      } else if (["custom", "pollinations", "aimlapi", "moonshot", "cometapi", "electronhub", "nanogpt", "zai", "siliconflow", "chutes", "workers_ai", "fireworks"].includes(source)) {
        if (thoughts) state.reasoning += data.choices?.find((item: any) => item?.delta?.reasoning_content)?.delta.reasoning_content ?? data.choices?.find((item: any) => item?.delta?.reasoning)?.delta.reasoning ?? "";
      } else if (source === "mistralai") {
        if (thoughts) state.reasoning += data.choices?.find((item: any) => item?.delta?.content?.[0]?.thinking)?.delta.content[0].thinking[0]?.text || "";
        const content = data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? "";
        return Array.isArray(content) ? content.map(item => item.text).filter(item => item).join("") : content;
      }
      return data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? "";
    },
    tryParseStreamingError: blocked("tryParseStreamingError (upstream error UI is not bound)"),
  };
  Object.defineProperty(openaiModule, "initialize", { value: async () => {
    settings = await host.request("openai.settings", {});
  } });
  return { "/scripts/openai.js": openaiModule };
}
