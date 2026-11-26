export type Data = Record<string, any>;
export type Capabilities = { resources?: Record<string, boolean>; generation?: Record<string, boolean>; features?: Record<string, unknown>; auth?: { csrf?: boolean } };
export type Target = { kind: "character" | "group"; id: string; name: string; members?: string[] };
export const encode = encodeURIComponent;
export const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export const messageOf = (error: unknown) => error instanceof Error ? error.message : "Operation failed.";
export const enabled = (capabilities: Capabilities, scope: "resources" | "generation", key: string) => capabilities[scope]?.[key] === true;

export function objectJson(text: string, limit = 1_048_576): Data {
  if (new TextEncoder().encode(text).length > limit * 8) throw new Error("The JSON draft is too large to inspect safely.");
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { throw new Error("Invalid JSON. Your draft has been kept."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A JSON object is required.");
  if (new TextEncoder().encode(JSON.stringify(value)).length > limit) throw new Error(`JSON exceeds the ${limit.toLocaleString()} byte limit.`);
  return value;
}

export async function jsonFile(file: File, limit: number) {
  if (file.size > limit) throw new Error("File exceeds this resource's size limit.");
  return objectJson(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()), limit);
}

export async function base64File(file: File, limit: number) {
  if (!file.size || file.size > limit) throw new Error("File is empty or exceeds this resource's size limit.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(binary);
}

export function downloadFile(file: { dataBase64: string; fileName: string; mimeType: string }) {
  const bytes = Uint8Array.from(atob(file.dataBase64), character => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.fileName; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function cardField(card: Data, key: string, value: string) {
  // Do not normalize a V1 card into V2 or flatten a V2/V3 card.
  return card.data && typeof card.data === "object" && !Array.isArray(card.data) ? { ...card, data: { ...card.data, [key]: value } } : { ...card, [key]: value };
}

export const chatPath = (target: Target, chatId: string) => target.kind === "group" ? `/groups/${encode(target.id)}/chats/${encode(chatId)}` : `/chats/${encode(chatId)}`;
export const chatQuery = (target: Target) => target.kind === "character" ? `characterId=${encode(target.id)}` : "";
export const terminal = (status: string) => ["done", "error", "failed", "cancelled", "unknown"].includes(status);
export type PendingGeneration = { clientRequestId: string; characterId: string; chatId: string; targetKind: "character" | "group"; requestId?: string };
export function pendingKey(base: string, handle: string, pending: Pick<PendingGeneration, "clientRequestId">) { return `st-v1-pending:${encode(base)}:${encode(handle)}:${pending.clientRequestId}`; }
export function listPending(storage: Pick<Storage, "length" | "key" | "getItem">, base: string, handle: string, target: Target, chatId: string): PendingGeneration[] {
  const prefix = `st-v1-pending:${encode(base)}:${encode(handle)}:`;
  const result: PendingGeneration[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key && /^st-v1-pending:[^:]+$/.test(key)) throw new Error(`Legacy unscoped caller identity ${key.slice("st-v1-pending:".length)} needs inspection on its original server. Use caller-ID lookup in Generation recovery before migrating it.`);
    if (!key?.startsWith(prefix)) continue;
    let value;
    try { value = JSON.parse(storage.getItem(key) ?? "null"); } catch { throw new Error("A saved caller identity is corrupt. Inspect local pending state before dispatching another generation."); }
    if (!value || typeof value.clientRequestId !== "string" || typeof value.characterId !== "string" || typeof value.chatId !== "string" || !["character", "group"].includes(value.targetKind)) throw new Error("A saved caller identity is invalid. Inspect local pending state before dispatching another generation.");
    if (value.chatId === chatId && value.targetKind === target.kind && (target.kind === "group" || value.characterId === target.id)) result.push(value);
  }
  return result;
}

export const DOCUMENTS = {
  prompts: { title: "Prompt Manager", path: "/prompt-manager", capability: "promptManager", keys: ["prompts", "order"], limit: 524_288, help: "Edit active prompts and global order. Roles, markers, depths, priorities and triggers follow upstream Prompt Manager. Provider settings are preserved." },
  variables: { title: "Global variables", path: "/macro-variables/global", capability: "macroManagement", keys: ["variables", "experimental"], limit: 8_388_608, help: "Global variables (up to 7 MiB) and macro engine switch. Reading and saving never execute macros. Chat variables are edited separately inside a chat." },
  regex: { title: "Regex scripts & scopes", path: "/regex-settings", capability: "regexManagement", keys: ["settings"], limit: 1_048_576, help: "Global scripts run in source order. Character/preset scopes need a separate explicit grant; importing never grants trust. Slash commands and full scoped parity remain unavailable." },
  worldSettings: { title: "World Info settings & bindings", path: "/world-info-settings", capability: "worldInfoManagement", keys: ["settings"], limit: 1_048_576, help: "Configure globalSelect, extra character books and scanner settings. Book, scan-settings and chat-binding revisions are independent." },
} as const;
export function editableDocument(document: Data, keys: readonly string[]) { return Object.fromEntries(keys.filter(key => Object.hasOwn(document, key)).map(key => [key, document[key]])); }
export function revisionBody(document: Data, draft: Data, keys: readonly string[]) {
  if (typeof document.revision !== "string" || !document.revision) throw new Error("Inspect a revision before saving.");
  if (Object.keys(draft).some(key => !keys.includes(key))) throw new Error("Unknown document field. Do not edit the revision or envelope.");
  return { ...draft, expectedRevision: document.revision };
}
