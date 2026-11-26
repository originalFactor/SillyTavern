export const PRESET_KINDS = [
  { id: "chat-completion", label: "Chat Completion" },
  { id: "context", label: "Context" },
  { id: "instruct", label: "Instruct" },
  { id: "sysprompt", label: "System prompt" },
] as const;

export type PresetKind = typeof PRESET_KINDS[number]["id"];
export type PresetEntry = { name: string; revision: string; origin: "user" | "builtin" };
export type PresetCatalog = {
  kind: PresetKind;
  activeName: string;
  activeRevision: string;
  presets: PresetEntry[];
  warnings: { name: string; message: string }[];
};
export type PresetDocument = PresetEntry & {
  kind: PresetKind;
  preset: Record<string, unknown>;
  credentialsRedacted: boolean;
  connectionChanges: string[];
  connectionSettings: Record<string, unknown>;
  compatibilityWarnings: { code: string; identifier: string; enabled: boolean }[];
};

export const MAX_PRESET_BYTES = 1_048_576;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

export function parsePreset(text: string): Record<string, unknown> {
  if (bytes(text) > MAX_PRESET_BYTES) throw new Error("Preset JSON must be at most 1 MiB.");
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { throw new Error("Invalid JSON. Fix the document before saving."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A preset must be a JSON object.");
  return value as Record<string, unknown>;
}

export function validatePresetName(name: string): string {
  if (!name.trim() || name !== name.trim() || bytes(name) > 200 || /[\\/:*?"<>|\x00-\x1f]/.test(name) || name.includes("..") || name.endsWith(".")) {
    throw new Error("Use a name of at most 200 UTF-8 bytes, without path characters, trailing dots, or surrounding spaces.");
  }
  return name;
}

export function presetPath(kind: PresetKind, name?: string): string {
  return `/presets/${kind}${name === undefined ? "" : `/${encodeURIComponent(name)}`}`;
}

export function presetSaveBody(name: string, text: string, inspected: PresetDocument | null) {
  validatePresetName(name);
  return {
    preset: parsePreset(text),
    // A different name creates a copy. Never obtain a fresh revision merely to
    // overwrite a collision: the user must inspect that target first.
    ...(inspected?.name === name ? { expectedRevision: inspected.revision } : {}),
  };
}

export async function readPresetFile(file: File) {
  if (file.size > MAX_PRESET_BYTES) throw new Error("Preset JSON must be at most 1 MiB.");
  // Reject malformed UTF-8 rather than replacing bytes inside prompt content.
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error("Could not read the file as UTF-8 JSON."); }
  const preset = parsePreset(text);
  const name = file.name.replace(/\.json$/i, "");
  validatePresetName(name);
  return { name, text: JSON.stringify(preset, null, 2) };
}
