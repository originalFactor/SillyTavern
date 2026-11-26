// Source-derived from STOriginal/public/scripts/extensions/regex/engine.js.
// Serialized into the settings frame; native state is a detached read snapshot.
export function installExtensionRegex(_w: any, host: any) {
  const SCRIPT_TYPES = { GLOBAL: 0, PRESET: 2, SCOPED: 1 };
  const SCRIPT_TYPE_UNKNOWN = -1;
  const regex_placement = { MD_DISPLAY: 0, USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 };
  const substitute_find_regex = { NONE: 0, RAW: 1, ESCAPED: 2 };
  const caches = new WeakMap<RegexProvider, Map<string, RegExp>>();
  class RegexProvider {
    static instance: RegexProvider;
    constructor() { caches.set(this, new Map()); }
    get(regexString: string) {
      const cache = caches.get(this)!;
      const regex = cache.get(regexString) ?? host.regexFromString(regexString);
      if (!regex) return null;
      if (cache.has(regexString)) cache.delete(regexString);
      else if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
      cache.set(regexString, regex);
      if (regex.global || regex.sticky) regex.lastIndex = 0;
      return regex;
    }
    clear() { caches.get(this)!.clear(); }
  }
  RegexProvider.instance = new RegexProvider();
  let snapshot: { enabled: boolean; scripts: any[]; characterAllowed: string[]; presetAllowed: Record<string, string[]>; apiId: string | null; presetName: string | null; presetScripts: any[] } | undefined;
  const clone = (value: any) => JSON.parse(JSON.stringify(value));
  const state = () => {
    const context = host.getContext?.();
    if (host.hasNativeChat ? host.hasNativeChat() : context?.groupId || context?.characterId !== undefined || context?.chat !== undefined) return host.unsupported("regex scripts (native scoped regex evaluation is not bound)");
    if (!snapshot) return host.unsupported("regex scripts (settings snapshot is not loaded)");
    return snapshot;
  };
  const substitute = (value: string) => {
    if (value.includes("{{")) return host.unsupported("regex macro substitution (native macro context is not bound)");
    return value;
  };
  function isScopedScriptsAllowed(character: any) { return !!state().characterAllowed.includes(character?.avatar); }
  function isPresetScriptsAllowed(apiId: string, presetName: string) {
    if (!apiId || !presetName) return false;
    const allowed = state().presetAllowed;
    return Object.hasOwn(allowed, apiId) && allowed[apiId].includes(presetName);
  }
  function getScriptsByType(scriptType: number, { allowedOnly = false } = {}) {
    switch (scriptType) {
      case SCRIPT_TYPES.GLOBAL: return clone(state().scripts);
      // Settings frames have no selected character. They never borrow the
      // workspace's character, transcript, or its regex grants implicitly.
      case SCRIPT_TYPES.SCOPED: state(); return [];
      case SCRIPT_TYPES.PRESET: {
        const value = state();
        return allowedOnly && !isPresetScriptsAllowed(value.apiId!, value.presetName!) ? [] : clone(value.presetScripts);
      }
      default: return [];
    }
  }
  function getRegexScripts(options = { allowedOnly: false }) { return Object.values(SCRIPT_TYPES).flatMap(type => getScriptsByType(type, options)); }
  function runRegexScript(regexScript: any, rawString: string, { characterOverride: _characterOverride }: any = {}) {
    if (!regexScript || regexScript.disabled || !regexScript.findRegex || !rawString) return rawString;
    const mode = Number(regexScript.substituteRegex);
    // RAW/ESCAPED only differ when macros are expanded. Reject those expansions
    // rather than evaluating them against a guessed character or empty frame.
    const pattern = mode === substitute_find_regex.RAW || mode === substitute_find_regex.ESCAPED ? substitute(regexScript.findRegex) : regexScript.findRegex;
    const regex = RegexProvider.instance.get(pattern);
    if (!regex) return rawString;
    return rawString.replace(regex, (...args: any[]) => {
      const replacement = regexScript.replaceString.replace(/{{match}}/gi, "$0");
      const withGroups = replacement.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_: string, num: string, groupName: string) => {
        const groups = args[args.length - 1];
        let match = num ? args[Number(num)] : groups && typeof groups === "object" && groups[groupName];
        if (!match) return "";
        // Match the backend's normalization of scripts with omitted trimStrings.
        for (const trim of regexScript.trimStrings ?? []) match = match.replaceAll(substitute(trim), "");
        return match;
      });
      return substitute(withGroups);
    });
  }
  function getRegexedString(rawString: string, placement: number, { characterOverride, isMarkdown, isPrompt, isEdit, depth }: any = {}) {
    if (typeof rawString !== "string") return "";
    if (!rawString || placement === undefined) return rawString;
    if (!state().enabled) return rawString;
    let finalString = rawString;
    for (const script of getRegexScripts({ allowedOnly: true })) {
      if (!((script.markdownOnly && isMarkdown) || (script.promptOnly && isPrompt) || (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt))) continue;
      if (isEdit && !script.runOnEdit) continue;
      if (typeof depth === "number") {
        if (!isNaN(script.minDepth) && script.minDepth !== null && script.minDepth >= -1 && depth < script.minDepth) continue;
        if (!isNaN(script.maxDepth) && script.maxDepth !== null && script.maxDepth >= 0 && depth > script.maxDepth) continue;
      }
      if (script.placement.includes(placement)) finalString = runRegexScript(script, finalString, { characterOverride });
    }
    return finalString;
  }
  const regexModule: Record<string, any> = {
    SCRIPT_TYPES, SCRIPT_TYPE_UNKNOWN, RegexProvider, regex_placement, substitute_find_regex,
    getRegexScripts, getScriptsByType, isScopedScriptsAllowed, isPresetScriptsAllowed,
    getCurrentPresetAPI: () => state().apiId, getCurrentPresetName: () => state().presetName,
    getRegexedString, runRegexScript,
    saveScriptsByType: async () => host.unsupported("saveScriptsByType (native revision and scope confirmation lifecycle is not bound)"),
  };
  for (const name of ["allowScopedScripts", "disallowScopedScripts", "allowPresetScripts", "disallowPresetScripts"]) regexModule[name] = () => host.unsupported(`${name} (native scope confirmation lifecycle is not bound)`);
  Object.defineProperty(regexModule, "initialize", { value: async () => { snapshot = await host.request("regex.snapshot", {}); } });
  return { "/scripts/extensions/regex/engine.js": regexModule };
}
