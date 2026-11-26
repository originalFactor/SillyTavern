// Source-derived read interfaces from STOriginal/public/scripts/preset-manager.js.
// Serialized into an opaque frame. All native operations stay in the parent.
export function installExtensionPresets(w: any, host: any) {
  const kinds: Record<string, string> = { openai: "chat-completion", context: "context", instruct: "instruct", sysprompt: "sysprompt" };
  let snapshot: { mainApi: string; catalogs: { kind: string; activeName: string; settings: any; presets: { name: string; preset: any }[] }[] } | undefined;
  const clone = (value: any) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const requireSnapshot = () => {
    if (!snapshot) return host.unsupported("preset manager (preset snapshot is not loaded)");
    return snapshot;
  };
  const catalog = (api: string): any => {
    const kind = Object.hasOwn(kinds, api) ? kinds[api] : undefined;
    const found = kind && requireSnapshot().catalogs.find((item: any) => item.kind === kind);
    if (!found) return host.unsupported(`preset manager API: ${api}`);
    return found;
  };
  class PresetManager {
    constructor(public apiId: string) {}
    getAllPresets() { return catalog(this.apiId).presets.map((item: any) => item.name); }
    findPreset(name: string) {
      const index = catalog(this.apiId).presets.findIndex((item: any) => item.name === name);
      return index < 0 ? undefined : this.isKeyedApi() ? name : String(index);
    }
    getSelectedPreset() { return this.findPreset(this.getSelectedPresetName()); }
    getSelectedPresetName() { return catalog(this.apiId).activeName; }
    isKeyedApi() { return this.apiId === "textgenerationwebui" || this.isAdvancedFormatting(); }
    isAdvancedFormatting() { return ["context", "instruct", "sysprompt", "reasoning"].includes(this.apiId); }
    getPresetList(api = this.apiId) {
      const value = catalog(api);
      const presets = value.presets.map((item: any) => clone(item.preset));
      const preset_names = api === "openai" ? Object.fromEntries(value.presets.map((item: any, index: number) => [item.name, index])) : value.presets.map((item: any) => item.name);
      const settings = api === "openai" ? Object.fromEntries(Object.entries(value.settings).map(([key, item]) => [Object.hasOwn(host.settingKeys, key) ? host.settingKeys[key] : key, clone(item)])) : clone(value.settings);
      return { presets, preset_names, settings };
    }
    getCompletionPresetByName(name: string) { return clone(catalog(this.apiId).presets.find((item: any) => item.name === name)?.preset); }
    readPresetExtensionField({ name, path }: { name?: string; path?: string | string[] }) {
      const value = catalog(this.apiId);
      const selectedName = this.getSelectedPresetName();
      const presetName = name || selectedName;
      const preset = selectedName === presetName ? value.settings : value.presets.find((item: any) => item.name === presetName)?.preset;
      if (!preset) return null;
      const extensions = preset.extensions && typeof preset.extensions === "object" && !Array.isArray(preset.extensions) ? preset.extensions : {};
      if (!path) return clone(extensions);
      const keys = typeof path === "string" && Object.hasOwn(extensions, path) ? [path] : w._.toPath(path);
      let current: any = extensions;
      for (const key of keys) {
        if (["__proto__", "prototype", "constructor"].includes(key) || current == null || !Object.hasOwn(Object(current), key)) return null;
        current = current[key];
      }
      return current === undefined ? null : clone(current);
    }
  }
  // Preserve upstream method names, but fail before touching detached data or
  // native state. Revision checks/connection consent cannot be inferred here.
  for (const name of ["selectPreset", "updatePreset", "savePresetAs", "savePreset", "renamePreset", "deletePreset", "writePresetExtensionField", "getDefaultPreset"]) Object.defineProperty(PresetManager.prototype, name, { value: async (..._args: any[]) => host.unsupported(`PresetManager.${name} (native revision and confirmation lifecycle is not bound)`) });
  for (const name of ["updateList", "getPresetSettings"]) Object.defineProperty(PresetManager.prototype, name, { value: (..._args: any[]) => host.unsupported(`PresetManager.${name} (upstream live settings/UI is not bound)`) });
  Object.defineProperty(PresetManager.prototype, "select", { get: () => host.unsupported("PresetManager.select (upstream preset selector DOM)") });
  const managers = new Map<string, PresetManager>();
  const presetsModule = {
    getPresetManager(apiId = "") {
      let api = apiId || requireSnapshot().mainApi;
      if (api === "koboldhorde") api = "kobold";
      if (!Object.hasOwn(kinds, api)) return null;
      catalog(api);
      if (!managers.has(api)) managers.set(api, new PresetManager(api));
      return managers.get(api)!;
    },
    initPresetManager: async () => host.unsupported("initPresetManager (upstream DOM and slash command registration)"),
  };
  Object.defineProperty(presetsModule, "initialize", { value: async () => { snapshot = await host.request("presets.snapshot", {}); } });
  return { "/scripts/preset-manager.js": presetsModule };
}
