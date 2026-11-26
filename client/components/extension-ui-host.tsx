"use client";

import type { ExtensionPromptSourceRegistrar, ExtensionPromptSnapshot } from "@/lib/extension-prompts";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ExtensionGenerationState } from "@/lib/extension-chat";
import { createApiClient } from "@/lib/api";
import { extensionFrameDocument, type ExtensionBundle } from "@/lib/extension-host";
import { createExtensionResourceReader, observeExtensionProviderStatus, type ExtensionChatSelection } from "@/lib/extension-runtime/resources";
import { useI18n } from "@/lib/i18n";
import { encode, messageOf, type Data } from "@/lib/workspace";
import { Notice, useDraftGuard } from "./document-editor";

export function ExtensionUiHost({ extension, readOnly, onDirtyChange, onPrintMessages, onSetSendButtonsEnabled, selection, generationState, onRegisterPromptSource }: { extension: Data; readOnly: boolean; onDirtyChange: (dirty: boolean) => void; onPrintMessages?: (signal?: AbortSignal) => Promise<void>; onSetSendButtonsEnabled?: (enabled: boolean, signal: AbortSignal) => void; selection?: ExtensionChatSelection; generationState?: ExtensionGenerationState; onRegisterPromptSource?: ExtensionPromptSourceRegistrar }) {
  const { t, locale } = useI18n();
  const [api] = useState(createApiClient);
  const [document, setDocument] = useState("");
  const [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const [error, setError] = useState(""), [dirty, setDirty] = useState(false);
  const iframe = useRef<HTMLIFrameElement>(null);
  const loading = useRef<AbortController | null>(null);
  const session = useRef<{ channel: string; revision: string; stopped: boolean; pending: boolean; reads: number; resource: ReturnType<typeof createExtensionResourceReader>; abort: AbortController; stopStatus?: () => void; ready?: boolean; promptSequence: number; promptRead?: { id: number; resolve: (value: ExtensionPromptSnapshot) => void; reject: (error: Error) => void } } | null>(null);
  const generation = useRef(generationState ?? { isSendPress: false, isGroupGenerating: false });
  useLayoutEffect(() => {
    generation.current = generationState ?? { isSendPress: false, isGroupGenerating: false };
    const current = session.current;
    if (current && !current.stopped) iframe.current?.contentWindow?.postMessage({ channel: current.channel, type: "generation-state", value: generation.current }, "*");
  }, [generationState]);
  const discard = useDraftGuard(dirty, onDirtyChange);
  const path = `/extensions/${encode(extension.id)}`;

  useEffect(() => {
    let active = true;
    const receive = async (event: MessageEvent) => {
      const current = session.current;
      if (!active || !current || current.stopped || event.source !== iframe.current?.contentWindow || event.data?.channel !== current.channel) return;
      const data = event.data;
      if (data.type === "ready") {
        current.ready = true;
        setReady(true);
        iframe.current?.contentWindow?.postMessage({ channel: current.channel, type: "generation-state", value: generation.current }, "*");
        current.stopStatus ??= observeExtensionProviderStatus(current.resource, value => {
          if (active && session.current === current && !current.stopped) iframe.current?.contentWindow?.postMessage({ channel: current.channel, type: "provider-status", value }, "*");
        }, current.abort.signal);
        return;
      }
      if (data.type === "prompt-snapshot") {
        const pending = current.promptRead;
        if (!pending || data.id !== pending.id) return;
        if (data.error) pending.reject(Error(String(data.error).slice(0, 4096)));
        else pending.resolve(data.value);
        return;
      }
      if (data.type === "dirty" && typeof data.dirty === "boolean") { setDirty(data.dirty); return; }
      if (data.type === "diagnostic") { setError(String(data.message ?? "").slice(0, 4096)); return; }
      const reply = (result: object) => { if (active && session.current === current) iframe.current?.contentWindow?.postMessage({ channel: current.channel, type: "result", id: data.id, ...result }, "*"); };
      if (data.type === "resource") {
        if (!Number.isSafeInteger(data.id) || current.reads >= 4) { reply({ error: "Extension resource read is unavailable or invalid." }); return; }
        current.reads++;
        try { reply({ value: await current.resource(data.operation, data.args) }); }
        catch (cause) { reply({ error: messageOf(cause) }); }
        finally { current.reads--; }
        return;
      }
      if (data.type !== "save") return;
      if (readOnly || current.pending || !Number.isSafeInteger(data.id) || !data.patch || typeof data.patch !== "object" || Array.isArray(data.patch) || new TextEncoder().encode(JSON.stringify(data.patch)).length > 1_048_576) {
        reply({ error: "Extension settings write is unavailable or invalid." }); return;
      }
      current.pending = true;
      try {
        const next = await api<Data>(`${path}/settings`, { method: "PATCH", headers: { "If-Match": current.revision }, body: JSON.stringify(data.patch) });
        current.revision = next.revision;
        reply({ value: next });
      } catch (cause) {
        current.stopped = true;
        current.abort.abort();
        const detail = messageOf(cause);
        reply({ error: detail });
        if (active) setError(detail);
      } finally { current.pending = false; }
    };
    window.addEventListener("message", receive);
    return () => { active = false; loading.current?.abort(); if (session.current) { session.current.stopped = true; session.current.abort.abort(); } window.removeEventListener("message", receive); };
  }, [api, path, readOnly, onPrintMessages, onSetSendButtonsEnabled, selection, onRegisterPromptSource]);

  const launch = async () => {
    if (!discard()) return;
    loading.current?.abort();
    const abort = new AbortController();
    loading.current = abort;
    if (session.current) { session.current.stopped = true; session.current.abort.abort(); }
    session.current = null;
    setDocument(""); setReady(false); setDirty(false); setBusy(true); setError("");
    try {
      const [bundle, settings] = await Promise.all([api<ExtensionBundle>(`${path}/ui`, { signal: abort.signal }), api<Data>(`${path}/settings`, { signal: abort.signal })]);
      if (abort.signal.aborted || loading.current !== abort) return;
      const channel = crypto.randomUUID();
      const resource = createExtensionResourceReader(api, abort.signal, { selection, allowPersonaSelection: !readOnly, printMessages: onPrintMessages, setSendButtonsEnabled: onSetSendButtonsEnabled, isCurrent: () => session.current?.channel === channel && !session.current.stopped });
      session.current = { channel, revision: settings.revision, stopped: false, pending: false, reads: 0, resource, abort, promptSequence: 0 };
      const bound = session.current;
      onRegisterPromptSource?.(() => new Promise<ExtensionPromptSnapshot>((resolve, reject) => {
        if (session.current !== bound || bound.stopped || abort.signal.aborted || !bound.ready || bound.promptRead) { reject(Error("Extension prompt source is not ready. Close or reload its interface before submitting.")); return; }
        const id = ++bound.promptSequence;
        const finish = (error?: Error, value?: ExtensionPromptSnapshot) => {
          if (bound.promptRead?.id !== id) return;
          bound.promptRead = undefined; clearTimeout(timer); abort.signal.removeEventListener("abort", cancelled);
          if (error) reject(error); else resolve(value!);
        };
        const cancelled = () => finish(Error("Extension prompt session was replaced or aborted."));
        const timer = setTimeout(() => finish(Error("Extension prompt filters timed out. No native request was sent.")), 10_000);
        bound.promptRead = { id, resolve: value => finish(undefined, value), reject: error => finish(error) };
        abort.signal.addEventListener("abort", cancelled, { once: true });
        iframe.current?.contentWindow?.postMessage({ channel, type: "collect-prompts", id }, "*");
      }), abort.signal);
      setDocument(extensionFrameDocument(bundle, settings.settings, channel, readOnly, locale, generation.current, Boolean(onRegisterPromptSource)));
    } catch (cause) { if (!abort.signal.aborted) setError(messageOf(cause)); }
    finally { if (!abort.signal.aborted && loading.current === abort) setBusy(false); }
  };
  // Loading is explicit; selecting an extension never runs its code.
  return <section className="settings-card extension-ui-host" aria-busy={busy}>
    <div className="resource-actions"><h2>{extension.displayName}</h2><button className="secondary-btn" disabled={busy} onClick={() => void launch()}>{t(document ? "Reload extension UI" : "Load extension UI")}</button></div>
    <p className="resource-help">{t("This runs the extension's own interface in an isolated frame. It can read character cards, selected conversation messages and metadata, and extension, World Info, Persona and preset catalogs, read World Info settings, preset contents and regex scripts, select a Persona and save its own settings. Credentials, arbitrary API calls, generation and tool execution are unavailable.")}</p>
    {onPrintMessages && <p className="resource-help">{t("This extension interface can refresh the selected conversation with printMessages.")}</p>}
    {onSetSendButtonsEnabled && <p className="resource-help">{t("This extension interface can temporarily disable sending and reply alternatives.")}</p>}
    {onRegisterPromptSource && <p className="resource-help">{t("This extension interface can add temporary prompts to previews and generations you submit in this conversation.")}</p>}
    {readOnly && <p className="resource-warning">{t("Extension settings are read-only on this server.")}</p>}
    <Notice error={error}/>
    {document ? <><p role="status" className="resource-help">{t(ready ? "Extension modules loaded. Unsupported host APIs appear as diagnostics." : "Loading extension modules…")}</p><iframe ref={iframe} title={extension.displayName} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document} className="extension-ui-frame"/></> : <p className="resource-help">{t("Load the extension UI to configure it. Selecting an extension does not execute its scripts.")}</p>}
    {dirty && <p role="status" className="resource-warning">{t("Unsaved draft")}</p>}
  </section>;
}
