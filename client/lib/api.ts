export type Connection = { baseUrl: string; token: string };
export type ApiRequestInit = RequestInit & { timeoutMs?: number };
export type Character = { id: string; name: string; avatar?: string; description?: string; chatCount?: number; [key: string]: unknown };
export type ChatMessage = { index: number; name?: string; mes?: string; is_user?: boolean; is_system?: boolean; send_date?: string; swipes?: string[]; swipe_id?: number; native_display?: string; native_display_reasoning?: string; extra?: Record<string, unknown>; [key: string]: unknown };

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly requestId?: string, readonly details?: unknown, readonly retryable = false) { super(message); }
}

export function connectionBase(value: string) {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use an HTTP(S) server origin without a path, credentials, query or fragment.");
  return url.origin;
}

export function apiUrl(base: string, path: string) {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("Invalid V1 resource path.");
  const url = new URL(`${connectionBase(base)}/api/v1${path}`);
  if (!url.pathname.startsWith("/api/v1/")) throw new Error("Only /api/v1 resources are allowed.");
  return url.toString();
}

let sessionToken = "";
let sessionBase = "";
let connectionVersion = 0;
export function setSessionToken(token: string) {
  const base = readConnection()?.baseUrl;
  const next = base ? connectionBase(base) : "";
  if (token && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(next).hostname)) throw new Error("Companion bearer capabilities must stay on a loopback connection.");
  sessionBase = next; sessionToken = token; connectionVersion++;
}
export const activeConnectionBase = () => sessionBase;

export function createApiClient() {
  const version = connectionVersion;
  return async function boundApi<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
    if (version !== connectionVersion) throw new Error("The authenticated connection changed. Reopen this resource before continuing.");
    return api<T>(path, init);
  };
}

export function readConnection(): Connection | null {
  if (typeof window === "undefined") return null;
  try { const value = localStorage.getItem("st-v1-base-url"); return value ? { baseUrl: value, token: sessionToken } : null; } catch { return null; }
}

export async function api<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { timeoutMs = 30_000, ...request } = init;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Invalid API request timeout.");
  const version = connectionVersion;
  // A different tab changing localStorage must not redirect this tab's token.
  const connection = sessionBase ? { baseUrl: sessionBase, token: sessionToken } : readConnection();
  if (!connection) throw new Error("Connect to a SillyTavern API v1 server first.");
  const headers = new Headers(init.headers);
  if (sessionToken) headers.set("Authorization", `Bearer ${sessionToken}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const response = await fetch(apiUrl(connection.baseUrl, path), { ...request, headers, signal, redirect: "error", cache: "no-store", credentials: "include" });
  if (response.status === 204) return undefined as T;
  let payload;
  try { payload = await response.json(); }
  catch { throw new ApiError("The V1 response is incomplete or invalid JSON. Inspect server state before retrying a write.", response.status, "invalid_response"); }
  if (version !== connectionVersion) throw new Error("The authenticated connection changed. Reopen this resource before continuing.");
  if (!response.ok) {
    const error = payload?.error;
    throw new ApiError(error?.message || error?.detail || `Request failed (${response.status})`, response.status, error?.code ?? "http", error?.requestId, error?.details, error?.retryable === true);
  }
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("The V1 server did not return JSON. Inspect state before retrying a write.");
  return payload as T;
}

export const getList = <T,>(payload: unknown): T[] => Array.isArray(payload) ? payload as T[] :
  Array.isArray((payload as { items?: unknown[] })?.items) ? (payload as { items: T[] }).items :
    Array.isArray((payload as { characters?: unknown[] })?.characters) ? (payload as { characters: T[] }).characters : [];
