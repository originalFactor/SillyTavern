export type ExtensionPrompt = { value: string; position: number; depth: number; scan: boolean; role: number };
export type ExtensionPromptSnapshot = Record<string, ExtensionPrompt>;
export type ExtensionPromptSourceRegistrar = (read: () => Promise<ExtensionPromptSnapshot>, lifetime: AbortSignal) => void;

/** Parent-only registry. A closed/replaced source invalidates an in-flight capture. */
export function createExtensionPromptCollector() {
  const sources = new Map<AbortSignal, () => Promise<ExtensionPromptSnapshot>>();
  let revision = 0, disposed = false, collecting = false;
  const register: ExtensionPromptSourceRegistrar = (read, lifetime) => {
    if (disposed || lifetime.aborted || sources.has(lifetime)) throw Error("Extension prompt source is unavailable.");
    sources.set(lifetime, read); revision++;
    lifetime.addEventListener("abort", () => { sources.delete(lifetime); revision++; }, { once: true });
  };
  return {
    register,
    async collect(): Promise<ExtensionPromptSnapshot> {
      if (disposed || collecting) throw Error("Extension prompt capture is unavailable or already in progress.");
      collecting = true;
      const captured = revision;
      try {
        const result: ExtensionPromptSnapshot = Object.create(null);
        for (const read of sources.values()) {
          const snapshot = await read();
          if (disposed || captured !== revision) throw Error("Extension prompt sources changed during capture. Inspect and submit again.");
          if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw Error("Invalid extension prompt snapshot.");
          for (const [key, entry] of Object.entries(snapshot)) {
            if (!key || key.length > 128 || /[\x00-\x1f\x7f]/.test(key) || ["__proto__", "constructor", "prototype"].includes(key) || !entry || typeof entry.value !== "string" || entry.value.length > 65_536 || ![-1, 0, 1, 2].includes(entry.position) || !Number.isInteger(entry.depth) || entry.depth < 0 || entry.depth > 10000 || typeof entry.scan !== "boolean" || ![0, 1, 2].includes(entry.role) || Object.keys(entry).some(field => !["value", "position", "depth", "scan", "role"].includes(field))) throw Error("Invalid extension prompt snapshot.");
            if (Object.hasOwn(result, key)) throw Error("Multiple extension prompt sources use the same key.");
            result[key] = { ...entry };
          }
          if (Object.keys(result).length > 128 || new TextEncoder().encode(JSON.stringify(result)).length > 1_048_576) throw Error("Extension prompts exceed their size limit.");
        }
        return result;
      } finally { collecting = false; }
    },
    dispose() { disposed = true; revision++; sources.clear(); },
  };
}
