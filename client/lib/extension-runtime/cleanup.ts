// Serialized into the opaque settings frame. Authorities: STOriginal/public/
// script.js:cleanUpMessage/baseChatReplace/parseMesExamples,
// scripts/power-user.js and scripts/utils.js.
export function installExtensionCleanup(_w: any, host: any) {
  let snapshot: Record<string, any> | undefined;
  let initialization: Promise<void> | undefined;
  const unavailable = (name: string, api = "cleanUpMessage") => host.unsupported(`${api} (${name})`);
  const setting = (name: string, api = "cleanUpMessage") => {
    if (!snapshot) return unavailable("settings snapshot is not loaded", api);
    if (!Object.hasOwn(snapshot, name)) return unavailable(`${name} setting is unavailable`, api);
    return snapshot[name];
  };
  const literal = (text: string, api: string) => {
    // Legacy substitution recognizes angle-bracket aliases too. Do not silently
    // pass these through, even when a caller supplies explicit name overrides.
    if (text.includes("{{") || /<(?:USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/i.test(text)) return unavailable("macro evaluation context is not bound", api);
    return text;
  };
  function baseChatReplace(value: any, _name1Override: any = null, _name2Override: any = null) {
    // Source returns empty strings and non-string card fields unchanged before
    // consulting macro/settings state. The names only affect macro expansion.
    if (typeof value !== "string" || !value.length) return value;
    value = literal(value, "baseChatReplace");
    if (setting("collapse_newlines", "baseChatReplace")) value = collapseNewlines(value);
    return value.replace(/\r/g, "");
  }
  function parseMesExamples(examplesStr: any, isInstruct: any) {
    if (!examplesStr || examplesStr.length === 0 || examplesStr === "<START>") return [];
    if (!examplesStr.startsWith("<START>")) examplesStr = "<START>\n" + examplesStr.trim();
    // The source evaluates the separator even for OpenAI/Instruct, where the
    // eventual block heading ignores it. Keep that dependency and its failures.
    const separator = setting("exampleSeparator", "parseMesExamples");
    const exampleSeparator = separator ? `${literal(separator, "parseMesExamples")}\n` : "";
    const mainApi = host.reasoning.getMainApi();
    if (mainApi !== snapshot!.mainApi) return unavailable("API settings changed; reload the extension", "parseMesExamples");
    const blockHeading = mainApi === "openai" || isInstruct ? "<START>\n" : exampleSeparator;
    return examplesStr.split(/<START>/gi).slice(1).map((block: string) => `${blockHeading}${block.trim()}\n`);
  }
  function collapseNewlines(text: string) { return text.replace(/\n+/g, "\n"); }
  function fixMarkdown(text: string, forDisplay: boolean) {
    const format = /([*_]{1,2})([\s\S]*?)\1/gm;
    const matches: RegExpExecArray[] = [];
    let match: RegExpExecArray | null;
    while ((match = format.exec(text)) !== null) matches.push(match);
    let result = text;
    for (let i = matches.length - 1; i >= 0; i--) {
      const value = matches[i];
      const replacement = value[0].replace(/(\*|_)([\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]+)|([\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]+)(\*|_)/g, "$1$4");
      result = result.slice(0, value.index) + replacement + result.slice(value.index + value[0].length);
    }
    if (!forDisplay) return result;
    return result.split("\n").map(line => {
      let result = line;
      for (const char of ["*", '"']) {
        let count = 0;
        for (const value of line) if (value === char) count++;
        if (line.includes(char) && count % 2 !== 0) result = line.trimEnd() + char;
      }
      return result;
    }).join("\n");
  }
  function trimToEndSentence(input: string) {
    if (!input) return "";
    const punctuation = new Set(['.', '!', '?', '*', '"', ')', '}', '`', ']', '$', '。', '！', '？', '”', '）', '】', '’', '」', '_']);
    const characters = Array.from(input);
    let last = -1;
    for (let i = characters.length - 1; i >= 0; i--) {
      const char = characters[i];
      const emoji = /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu.test(char);
      if (punctuation.has(char) || emoji) {
        last = !emoji && i > 0 && /[\s\n]/.test(characters[i - 1]) ? i - 1 : i;
        break;
      }
    }
    return last === -1 ? input.trimEnd() : characters.slice(0, last + 1).join("").trimEnd();
  }
  function cleanUpMessage({ getMessage, isImpersonate, isContinue, displayIncompleteSentences = false, stoppingStrings = null, includeUserPromptBias = true, trimNames = true, trimWrongNames = true }: any = {}, ..._legacy: any[]) {
    if (arguments.length > 0 && typeof arguments[0] !== "object") {
      // Preserve legacy positional semantics, including omitted arguments becoming
      // undefined rather than receiving the object signature's defaults.
      [getMessage, isImpersonate, isContinue, displayIncompleteSentences, stoppingStrings, includeUserPromptBias, trimNames, trimWrongNames] = arguments;
    }
    if (!getMessage) return "";
    if (typeof getMessage !== "string") throw new TypeError("cleanUpMessage requires a string message.");
    const context = host.getContext?.();
    if (host.hasNativeChat ? host.hasNativeChat() : context?.groupId || context?.characterId !== undefined || context?.chat !== undefined) return unavailable("native character/group/chat cleanup is not bound");
    const mainApi = host.reasoning.getMainApi();
    if (!snapshot) return unavailable("settings snapshot is not loaded");
    if (mainApi !== snapshot.mainApi) return unavailable("API settings changed; reload the extension");
    if (mainApi !== "openai") return unavailable("only Chat Completion cleanup is bound");
    // Reject dependencies before regex evaluation; never use guessed names,
    // silently omit macros, or consume native generation stopping state.
    if (includeUserPromptBias && !isImpersonate && !isContinue && setting("hasUserPromptBias")) return unavailable("prompt bias requires a native macro context");
    if (!stoppingStrings) return unavailable("native stopping strings are not bound; pass stoppingStrings explicitly");
    if (!Array.isArray(stoppingStrings) || stoppingStrings.some(value => typeof value !== "string")) throw new TypeError("cleanUpMessage stoppingStrings must be an array of strings.");
    const allowCharacterName = setting("allow_name2_display");
    if (!allowCharacterName || ((isImpersonate ? trimNames : trimWrongNames) && !setting("allow_name1_display"))) return unavailable("name stripping requires a native character/user name context");
    for (const stop of stoppingStrings) {
      if (!stop.length) continue;
      for (let j = stop.length; j > 0; j--) {
        if (getMessage.slice(-j) === stop.slice(0, j)) { getMessage = getMessage.slice(0, -j); break; }
      }
    }
    getMessage = host.regex.getRegexedString(getMessage, isImpersonate ? host.regex.regex_placement.USER_INPUT : host.regex.regex_placement.AI_OUTPUT);
    if (setting("collapse_newlines")) getMessage = collapseNewlines(getMessage);
    getMessage = getMessage.replace(/[^\S\r\n]+$/gm, "");
    const endOfText = getMessage.indexOf("<|endoftext|>");
    if (endOfText !== -1) getMessage = getMessage.substring(0, endOfText);
    if (isImpersonate) getMessage = getMessage.trim();
    if (setting("auto_fix_generated_markdown")) getMessage = fixMarkdown(getMessage, false);
    if (isImpersonate) getMessage = getMessage.trim();
    if (!displayIncompleteSentences && setting("trim_sentences")) getMessage = trimToEndSentence(getMessage);
    // No PromptReasoning instance can be created in this settings frame. This is
    // the upstream no-instance branch, not access to a native generation prefix.
    if (setting("trim_spaces")) getMessage = getMessage.trim();
    return getMessage;
  }
  const result = { cleanUpMessage, baseChatReplace, parseMesExamples, collapseNewlines, fixMarkdown, trimToEndSentence };
  Object.defineProperty(result, "initialize", { value: () => initialization ??= (async () => { snapshot = await host.request("script.cleanupSettings", {}); })() });
  return result;
}
