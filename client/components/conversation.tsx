"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createApiClient, ApiError, activeConnectionBase, type ChatMessage } from "@/lib/api";
import { createExtensionPromptCollector, type ExtensionPromptSourceRegistrar } from "@/lib/extension-prompts";
import { createExtensionChatPrinter, createExtensionSendButtons, extensionGenerationState } from "@/lib/extension-chat";
import { chatPath, chatQuery, enabled, encode, listPending, messageOf, pendingKey, pretty, terminal, type Capabilities, type Data, type PendingGeneration, type Target } from "@/lib/workspace";
import { useI18n } from "@/lib/i18n";
import { DocumentEditor, Notice, useDraftGuard } from "./document-editor";
import { ExtensionsPanel } from "./extensions-panel";

type Page = { messages: ChatMessage[]; total: number; hasMore: boolean; views?: { index: number; display?: string; displayReasoning?: string }[]; warnings?: string[]; printTicket?: object };
type Anchor = { before?: number; after?: number };
// Keep source messages in state so locale changes only affect rendering, never lifecycle hooks.
type LocalText = string | { source: string; values?: Record<string, string | number>; detail?: LocalText };
class ConversationError extends Error {
  constructor(readonly text: Exclude<LocalText, string>) { super(text.source); }
}
const textOf = (error: unknown): LocalText => {
  if (error instanceof ConversationError) return error.text;
  const source = messageOf(error);
  // The API's synthesized HTTP fallback includes a status; retain it as interpolation.
  if (error instanceof ApiError && source === `Request failed (${error.status})`) return { source: "Request failed ({status})", values: { status: error.status } };
  return source;
};

const newest = Number.MAX_SAFE_INTEGER;
const KEYS = { sampling: ["overrides"], variables: ["variables"], world: ["name"] };

export function Conversation({ target, capabilities, handle, onDirtyChange }: { target: Target; capabilities: Capabilities; handle: string; onDirtyChange: (dirty: boolean) => void }) {
  const { t } = useI18n();
  const translate = (text: LocalText): string => typeof text === "string" ? t(text) : t(text.source, { ...text.values, ...(text.detail === undefined ? {} : { error: translate(text.detail) }) });
  const [api] = useState(createApiClient);
  const [chats, setChats] = useState<Data[]>([]), [chatId, setChatId] = useState("");
  const [groupRevision, setGroupRevision] = useState("");
  const [page, setPage] = useState<Page | null>(null), [pageVersion, setPageVersion] = useState(0);
  const anchor = useRef<Anchor>({ before: newest });
  const [rendered, setRendered] = useState(false), [draft, setDraft] = useState(""), [type, setType] = useState("normal");
  const [edit, setEdit] = useState<{ message: ChatMessage; text: string } | null>(null);
  const [tab, setTab] = useState("messages"), [editorDirty, setEditorDirty] = useState(false);
  const [showExtensions, setShowExtensions] = useState(false), [extensionDirty, setExtensionDirty] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<LocalText>(""), [message, setMessage] = useState<LocalText>("");
  const [preview, setPreview] = useState<Data | null>(null), [member, setMember] = useState(target.members?.[0]?.replace(/\.png$/, "") ?? "");
  const [records, setRecords] = useState<Data[]>([]), [nextRecord, setNextRecord] = useState<string | null>(null);
  const [record, setRecord] = useState<Data | null>(null), [watch, setWatch] = useState<string | null>(null), [reviewed, setReviewed] = useState("");
  const [pending, setPending] = useState<PendingGeneration[]>([]), [unresolved, setUnresolved] = useState(true), [inspectedMissing, setInspectedMissing] = useState("");
  const [lookupId, setLookupId] = useState("");
  const [submittingGeneration, setSubmittingGeneration] = useState(false);
  const epoch = useRef(0), posting = useRef(false);
  const pageRead = useRef(0), rows = useRef<HTMLDivElement>(null);
  const printer = useRef<ReturnType<typeof createExtensionChatPrinter<Page>> | null>(null);
  const promptCollector = useRef<ReturnType<typeof createExtensionPromptCollector> | null>(null);
  const sendButtons = useRef<ReturnType<typeof createExtensionSendButtons> | null>(null);
  const [extensionSendingDisabled, setExtensionSendingDisabled] = useState(false);
  const editing = useRef(false);
  const setAnchor = (next: Anchor) => { printer.current?.cancel(); pageRead.current++; anchor.current = next; setPageVersion(version => version + 1); };
  const dirty = Boolean(draft || edit || editorDirty || extensionDirty);
  useDraftGuard(dirty, onDirtyChange);
  const discard = () => !dirty || window.confirm(t("Discard the unsaved draft?"));
  const [base] = useState(activeConnectionBase);
  const group = target.kind === "group", path = chatId ? chatPath(target, chatId) : "", query = chatQuery(target);
  const extensionSelection = useMemo(() => chatId ? { kind: target.kind, id: target.id, chatId } : undefined, [target.kind, target.id, chatId]);
  const extensionGeneration = useMemo(() => extensionGenerationState(group, submittingGeneration,
    [...records, ...(record ? [record] : [])].filter(row => row.chatId === chatId && row.targetKind === target.kind && (group || row.characterId === target.id)).map(row => ({ requestId: row.requestId, seq: row.seq, status: row.status, drained: row.drained }))), [group, submittingGeneration, records, record, chatId, target.kind, target.id]);
  const resource = (name: string) => `${path}/${name}${query ? `?${query}` : ""}`;
  const cap = (name: string) => enabled(capabilities, "resources", name);
  const gen = (name: string) => enabled(capabilities, "generation", name);
  const nativeContext = () => ({ locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, isMobile: window.matchMedia("(max-width:620px)").matches });
  const listPath = group ? `/groups/${encode(target.id)}/chats` : `/characters/${encode(target.id)}/chats`;
  const loadChats = useCallback(async (signal?: AbortSignal) => {
    const result = await api<Data[]>(listPath, { signal }); if (!signal?.aborted) setChats(result);
    if (group) { const doc = await api<Data>(`/groups/${encode(target.id)}`, { signal }); if (!signal?.aborted) setGroupRevision(doc.revision); }
  }, [listPath, group, target.id, api]);
  useEffect(() => { const controller = new AbortController(); setBusy(true); loadChats(controller.signal).catch(e => { if (!controller.signal.aborted) setError(textOf(e)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); }); return () => controller.abort(); }, [loadChats]);

  const readPage = useCallback(async (signal?: AbortSignal, requestedAnchor = anchor.current) => {
    if (!chatId) throw Error("Select a conversation before printing messages.");
    const parameters = new URLSearchParams({ limit: "100", ...(query ? { characterId: target.id } : {}), ...Object.fromEntries(Object.entries(requestedAnchor).map(([key, value]) => [key, String(value)])) });
    return rendered ? await api<Page>(`${path}/render`, { method: "POST", signal, body: JSON.stringify({ ...(group ? {} : { characterId: target.id }), limit: 100, ...requestedAnchor, nativeContext: nativeContext() }) }) : await api<Page>(`${path}?${parameters}`, { signal });
  }, [chatId, query, target.id, rendered, group, path, api]);
  const loadPage = useCallback(async (signal?: AbortSignal) => {
    if (!chatId) return;
    printer.current?.cancel();
    const request = ++pageRead.current;
    const next = await readPage(signal);
    if (!signal?.aborted && request === pageRead.current) setPage(next);
  }, [chatId, readPage]);
  useLayoutEffect(() => {
    if (!chatId) return;
    const bound = createExtensionChatPrinter<Page>({
      read: signal => { pageRead.current++; return readPage(signal, { before: newest }); },
      publish: (next, ticket) => { anchor.current = { before: newest }; setPage({ ...next, printTicket: ticket }); },
      scroll: () => {
        if (!rows.current) throw Error("The transcript is no longer visible.");
        (rows.current.lastElementChild ?? rows.current).scrollIntoView({ block: "end" });
      },
    });
    printer.current = bound;
    return () => { bound.dispose(); if (printer.current === bound) printer.current = null; };
  }, [chatId, readPage]);
  useLayoutEffect(() => {
    editing.current = Boolean(edit || editorDirty);
    if (editing.current) printer.current?.cancel("Finish editing the chat before printing messages.");
  }, [edit, editorDirty]);
  useLayoutEffect(() => { if (page?.printTicket) printer.current?.committed(page.printTicket); }, [page]);
  const printMessages = useCallback((signal?: AbortSignal) => {
    if (editing.current) return Promise.reject(Error("Finish editing the chat before printing messages."));
    return printer.current?.printMessages(signal) ?? Promise.reject(Error("The selected conversation renderer is unavailable."));
  }, []);
  useLayoutEffect(() => {
    if (!chatId) return;
    const bound = createExtensionSendButtons(setExtensionSendingDisabled);
    sendButtons.current = bound;
    return () => { bound.dispose(); if (sendButtons.current === bound) sendButtons.current = null; };
  }, [chatId]);
  const setSendButtonsEnabled = useCallback((enabled: boolean, signal: AbortSignal) => {
    if (!sendButtons.current) throw Error("The selected conversation controls are unavailable.");
    sendButtons.current.setEnabled(enabled, signal);
  }, []);

  useLayoutEffect(() => {
    const bound = createExtensionPromptCollector(); promptCollector.current = bound;
    return () => { bound.dispose(); if (promptCollector.current === bound) promptCollector.current = null; };
  }, [chatId, target.id, target.kind]);
  const registerPromptSource = useCallback<ExtensionPromptSourceRegistrar>((read, lifetime) => {
    if (!promptCollector.current) throw Error("The selected conversation prompt collector is unavailable.");
    promptCollector.current.register(read, lifetime);
  }, []);
  const captureExtensionPrompts = async () => {
    if (!cap("clientExtensionPrompts")) return {};
    const bound = promptCollector.current, captured = epoch.current;
    if (!bound) throw Error("The selected conversation prompt collector is unavailable.");
    const snapshot = await bound.collect();
    if (bound !== promptCollector.current || captured !== epoch.current) throw Error("The selected conversation changed during extension prompt capture.");
    return Object.keys(snapshot).length ? { extensionPrompts: snapshot } : {};
  };

  const refreshOutcomes = useCallback(async (signal?: AbortSignal) => {
    if (!chatId) return;
    const params = new URLSearchParams({ characterId: target.id, chatId, targetKind: target.kind, limit: "20" });
    const [history, blocking] = await Promise.all([api<Data>(`/generations?${params}`, { signal }), api<Data>(`/generations?${params}&unresolvedOnly=true`, { signal })]);
    if (signal?.aborted) return;
    const saved = listPending(localStorage, base, handle, target, chatId);
    setRecords(history.generations); setNextRecord(history.nextBefore); setUnresolved(blocking.generations.length > 0);
    setPending(saved);
  }, [chatId, target, base, handle, api]);
  useEffect(() => {
    const controller = new AbortController(); epoch.current++; setBusy(true); setPage(null); setUnresolved(true);
    Promise.all([loadPage(controller.signal), chatId && gen("discovery") ? refreshOutcomes(controller.signal) : Promise.resolve().then(() => setUnresolved(false))]).catch(e => { if (!controller.signal.aborted) setError(textOf(e)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPage, refreshOutcomes, pageVersion]);

  const forgetCompleted = (next: Data) => {
    if (terminal(next.status) && next.drained === true && (next.acknowledged === true || next.status === "done")) {
      localStorage.removeItem(pendingKey(base, handle, { clientRequestId: next.clientRequestId }));
      setPending(listPending(localStorage, base, handle, target, chatId));
    }
  };
  useEffect(() => {
    if (!watch) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Data>(`/generations/${encode(watch)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setRecord(next);
        if (terminal(next.status) && next.drained === true) {
          forgetCompleted(next);
          setMessage(next.status === "done" ? next.committed ? "Generation complete." : "Quiet completion — no transcript row was committed." : "Generation stopped. Inspect the exact outcome before sending again.");
          await Promise.all([loadPage(controller.signal), refreshOutcomes(controller.signal)]);
          if (!controller.signal.aborted) setWatch(null);
        } else timer = setTimeout(() => void poll(), 1200);
      } catch (e) { if (!controller.signal.aborted) { setWatch(null); setError({ source: "{error} Observation stopped. Inspect the saved caller ID; no request was replayed.", detail: textOf(e) }); } }
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
    // Snapshot polling is an observation channel. Closing it never cancels or resubmits a generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch, loadPage, refreshOutcomes]);

  const run = async (action: () => Promise<void>) => { const current = epoch.current; setBusy(true); setError(""); setMessage(""); try { await action(); } catch (e) { if (current === epoch.current) setError({ source: "{error} Inspect current state before retrying; your draft has been kept.", detail: textOf(e) }); } finally { if (current === epoch.current) setBusy(false); } };
  const chooseChat = (id: string, confirmed = false) => { if (posting.current || (!confirmed && !discard())) return; printer.current?.cancel(); setShowExtensions(false); setExtensionDirty(false); setChatId(id); setWatch(null); setRecord(null); setReviewed(""); setDraft(""); setEdit(null); setPreview(null); setPending([]); setError(""); setMessage(""); setInspectedMissing(""); setAnchor({ before: newest }); setTab("messages"); };
  const create = () => run(async () => {
    if (!discard()) return;
    const id = `chat-${crypto.randomUUID()}`;
    try { const created = await api<Data>(listPath, { method: "POST", body: JSON.stringify({ chatId: id, ...(group ? { expectedRevision: groupRevision } : { nativeContext: nativeContext() }) }) }); await loadChats(); chooseChat(id, true); if (created.warnings) setMessage({ source: "Greeting warnings: {warnings}", values: { warnings: pretty(created.warnings) } }); }
    catch (e) { throw new ConversationError({ source: "{error} Creation ID: {id}. Reload the chat list and inspect variables before creating another chat.", values: { id }, detail: textOf(e) }); }
  });
  const rename = () => run(async () => { const nextId = window.prompt(t("New chat ID"), chatId); if (!nextId || nextId === chatId) return; await api(path, { method: "PATCH", body: JSON.stringify({ characterId: target.id, newChatId: nextId }) }); await loadChats(); chooseChat(nextId); });
  const deleteChat = () => run(async () => { if (!window.confirm(t("Delete chat {chatId}? This cannot be undone.", { chatId }))) return; const result = await api<Data>(`${path}?${group ? `expectedRevision=${encode(groupRevision)}` : query}`, { method: "DELETE" }); if (group) setGroupRevision(result.revision); chooseChat(""); await loadChats(); });
  const previewGeneration = () => run(async () => { setPreview(null); const extensionPrompts = await captureExtensionPrompts(); setPreview(await api<Data>(group ? `${path}/preview` : "/generations/preview", { method: "POST", body: JSON.stringify({ characterId: group ? member : target.id, chatId, type, input: ["normal", "quiet"].includes(type) ? draft : "", nativeContext: nativeContext(), ...extensionPrompts }) })); });
  const send = () => run(async () => {
    if (sendButtons.current?.isDisabled()) throw new Error("An extension has disabled sending and reply alternatives.");
    if (posting.current || watch || unresolved || pending.length) throw new Error("Resolve or inspect pending work before admitting another generation.");
    posting.current = true;
    let clientRequestId: string | undefined;
    try {
      const extensionPrompts = await captureExtensionPrompts();
      if (sendButtons.current?.isDisabled()) throw new Error("An extension has disabled sending and reply alternatives.");
      const key = `st-client-${crypto.randomUUID()}`;
      const local: PendingGeneration = { clientRequestId: key, characterId: target.id, chatId, targetKind: target.kind };
      // Capture filters before durable admission. A capture failure sends no POST.
      localStorage.setItem(pendingKey(base, handle, local), JSON.stringify(local)); setPending(previous => [...previous, local]);
      clientRequestId = key; setSubmittingGeneration(true);
      const accepted = await api<Data>(group ? `${path}/generations` : "/generations", { method: "POST", body: JSON.stringify({ characterId: target.id, chatId, clientRequestId, type, input: ["normal", "quiet"].includes(type) ? draft : "", nativeContext: nativeContext(), ...extensionPrompts }) });
      try { localStorage.setItem(pendingKey(base, handle, local), JSON.stringify({ ...local, requestId: accepted.requestId })); } catch { /* Keep observing the accepted request. */ }
      setDraft(""); setPreview(null); setUnresolved(true); setWatch(accepted.requestId); setRecord({ ...accepted, clientRequestId, characterId: target.id, chatId, targetKind: target.kind });
    } catch (e) {
      if (!clientRequestId) throw e;
      throw new ConversationError({ source: "{error} Caller ID {clientRequestId} is saved. Use Inspect caller ID, never resubmit automatically.", values: { clientRequestId }, detail: textOf(e) });
    } finally { posting.current = false; setSubmittingGeneration(false); }
  });
  const inspectPending = (item: PendingGeneration) => run(async () => {
    try { const next = await api<Data>(`/generations/by-client/${encode(item.clientRequestId)}`); setInspectedMissing(""); setRecord(next); setReviewed(""); forgetCompleted(next); if (!terminal(next.status) || next.drained === false) setWatch(next.requestId); await refreshOutcomes(); }
    catch (e) { if (e instanceof ApiError && e.status === 404) { setInspectedMissing(item.clientRequestId); throw new Error("No admission is visible yet. A delayed POST could still arrive. You may permanently abandon this caller key; do not resend it."); } throw e; }
  });
  const abandon = (item: PendingGeneration) => run(async () => { if (!window.confirm(t("Permanently abandon this caller key? Any delayed admission for it will be blocked. This does not replay the request."))) return; const next = await api<Data>(`/generations/by-client/${encode(item.clientRequestId)}/abandon`, { method: "POST", body: JSON.stringify({ characterId: item.characterId, chatId: item.chatId, targetKind: item.targetKind }) }); setRecord(next); forgetCompleted(next); await refreshOutcomes(); });
  const inspectRecord = (id: string) => run(async () => { const next = await api<Data>(`/generations/${encode(id)}`); setRecord(next); setReviewed(""); forgetCompleted(next); if (!terminal(next.status) || next.drained === false) setWatch(id); });
  const acknowledge = () => run(async () => { if (!record || watch || reviewed !== `${record.requestId}:${record.seq}`) return; const next = await api<Data>(`/generations/${encode(record.requestId)}/acknowledge`, { method: "POST", body: JSON.stringify({ expectedSeq: record.seq }) }); setRecord(next); setReviewed(""); forgetCompleted(next); await refreshOutcomes(); });
  const lookupCaller = () => run(async () => {
    const next = await api<Data>(`/generations/by-client/${encode(lookupId.trim())}`);
    if (next.chatId !== chatId || next.targetKind !== target.kind || (!group && next.characterId !== target.id)) throw new ConversationError({ source: "This caller belongs to {targetKind} {characterId}, chat {chatId}. Open that target to recover it.", values: { targetKind: next.targetKind, characterId: next.characterId, chatId: next.chatId } });
    setRecord(next); setReviewed("");
    if (!terminal(next.status) || next.drained === false) setWatch(next.requestId);
    const legacyKey = `st-v1-pending:${next.clientRequestId}`;
    if (localStorage.getItem(legacyKey) !== null && window.confirm(t("This server confirms the caller identity and chat. Migrate this inspected legacy pending identity into the current server/account scope? No request will be replayed."))) {
      const item: PendingGeneration = { clientRequestId: next.clientRequestId, requestId: next.requestId, characterId: next.characterId, chatId: next.chatId, targetKind: next.targetKind };
      localStorage.setItem(pendingKey(base, handle, item), JSON.stringify(item)); localStorage.removeItem(legacyKey);
    }
    forgetCompleted(next); await refreshOutcomes();
  });

  const rawRow = async (index: number) => {
    const params = new URLSearchParams({ ...(group ? {} : { characterId: target.id }), after: String(index - 1), limit: "1" });
    const latest = await api<Page>(`${path}?${params}`); const row = latest.messages.find(item => item.index === index);
    if (!row) throw new Error("Message no longer exists. Reload the transcript."); return row;
  };
  const mutate = (action: "edit" | "delete" | "swipe", row: ChatMessage, text?: string, swipeId?: number) => run(async () => {
    const checkSwipe = () => { if (action === "swipe" && sendButtons.current?.isDisabled()) throw new Error("An extension has disabled sending and reply alternatives."); };
    checkSwipe();
    if (action === "delete" && !window.confirm(t("Delete message at server index {index}?", { index: row.index }))) return;
    // Character mutations have no external expected-message field. Check the
    // displayed row before dispatch; group mutations also enforce it atomically.
    const current = await rawRow(row.index);
    if (current.mes !== row.mes || current.name !== row.name || current.swipe_id !== row.swipe_id || pretty(current.swipes) !== pretty(row.swipes)) throw new Error("Message changed. Reload before editing, deleting or selecting a swipe.");
    checkSwipe();
    if (group) await api(action === "swipe" ? `${path}/swipe` : `${path}/messages/${action}`, { method: "POST", body: JSON.stringify({ index: row.index, expectedMessage: row, ...(action === "edit" ? { text, nativeContext: nativeContext() } : {}), ...(action === "swipe" ? { swipeId } : {}) }) });
    else await api(`${path}/messages`, { method: "POST", body: JSON.stringify({ characterId: target.id, action, index: row.index, ...(action === "edit" ? { message: { mes: text }, nativeContext: nativeContext() } : {}), ...(action === "swipe" ? { swipeId } : {}) }) });
    setEdit(null); await loadPage();
  });
  const blocked = extensionSendingDisabled || busy || Boolean(watch) || unresolved || pending.length > 0 || !gen("durableAdmission") || !gen("discovery");
  const generationModes = ["normal", "regenerate", "continue", ...(!group ? ["quiet"] : [])].filter(mode => gen(group ? `group${mode[0].toUpperCase()}${mode.slice(1)}` : mode));
  const transcriptBusy = busy || Boolean(watch) || unresolved || pending.length > 0;
  const settingTabs = [{ id: "sampling", label: "Sampling", show: group ? cap("groupChatSampling") : cap("chatSampling"), keys: KEYS.sampling, name: "sampling" }, { id: "variables", label: "Local variables", show: !group && cap("macroManagement"), keys: KEYS.variables, name: "variables" }, { id: "world", label: "World book", show: !group && cap("worldInfoManagement"), keys: KEYS.world, name: "world-info" }];
  return <div className="settings-page conversation-page"><div className="settings-heading"><div><div className="heading-kicker">{group ? t("GROUP · SUPPORTED SUBSET") : t("CONVERSATIONS")}</div><h1>{target.name}</h1><p>{chatId || t("Choose a chat or create one.")}</p></div><div className="resource-actions"><button className="secondary-btn" disabled={busy} onClick={() => void run(() => loadChats())}>{t("Refresh chats")}</button><button className="primary-btn" disabled={busy || !(group ? cap("groupChatCreate") : cap("chatCreate"))} onClick={() => void create()}>{t("New chat")}</button></div></div><Notice error={translate(error)} message={translate(message)}/><div className="conversation-workspace"><aside className="settings-card chat-picker">{chats.map(chat => <button key={chat.id} disabled={busy || chat.missing} className={`preset-item ${chatId === chat.id ? "selected" : ""}`} onClick={() => chooseChat(chat.id)}><span>{chat.id}</span>{chat.missing && <small>{t("Missing file")}</small>}</button>)}</aside><section className="settings-card chat-panel">{!chatId ? <p className="resource-help">{t("Select a conversation.")}</p> : <>
      <div className="resource-actions"><button className="secondary-btn" disabled={busy} onClick={() => { if (discard()) { setEdit(null); void run(async () => { await Promise.all([loadPage(), refreshOutcomes()]); }); } }}>{t("Reload transcript & outcomes")}</button>{!group && cap("chatRename") && <button className="secondary-btn" disabled={transcriptBusy || Boolean(draft || edit)} onClick={() => void rename()}>{t("Rename")}</button>}{(group ? cap("groupChatDelete") : cap("chatDelete")) && <button className="secondary-btn danger-button" disabled={transcriptBusy || Boolean(draft || edit)} onClick={() => void deleteChat()}>{t("Delete chat")}</button>}</div>
      <div className="resource-tabs">{[{ id: "messages", label: "Messages" }, { id: "outcomes", label: "Generation recovery" }, ...settingTabs.filter(item => item.show)].map(item => <button key={item.id} className={tab === item.id ? "selected" : ""} disabled={busy} onClick={() => { if ((editorDirty || extensionDirty) && !window.confirm(t("Discard the unsaved draft?"))) return; setShowExtensions(false); setExtensionDirty(false); setTab(item.id); }}>{t(item.label)}</button>)}</div>
      {tab === "messages" && <><div className="resource-actions"><button className="secondary-btn" disabled={busy || !page?.messages.length || page.messages[0].index === 0 || Boolean(edit)} onClick={() => setAnchor({ before: page!.messages[0].index })}>{t("Older")}</button><button className="secondary-btn" disabled={busy || !page?.messages.length || page.messages.at(-1)!.index >= page.total - 1 || Boolean(edit)} onClick={() => setAnchor({ after: page!.messages.at(-1)!.index })}>{t("Newer")}</button><button className="secondary-btn" disabled={busy || Boolean(edit)} onClick={() => setAnchor({ before: newest })}>{t("Latest")}</button><span className="resource-help">{page ? t("{first}–{last} / {total} stored rows", { first: page.messages[0]?.index ?? 0, last: page.messages.at(-1)?.index ?? 0, total: page.total }) : t("Loading…")}</span>{(group ? cap("groupChatRender") : cap("renderedTranscript")) && <label className="check-field"><input type="checkbox" checked={rendered} disabled={busy || Boolean(edit)} onChange={event => setRendered(event.target.checked)}/>{t("Display projection")}</label>}</div>
        {cap("extensions") && <div className="resource-actions"><button className="secondary-btn" aria-expanded={showExtensions} onClick={() => { if (showExtensions && extensionDirty && !window.confirm(t("Discard the unsaved extension settings draft?"))) return; setShowExtensions(!showExtensions); setExtensionDirty(false); }}>{t("Extensions")}</button></div>}
        {showExtensions && <ExtensionsPanel key={chatId} capabilities={capabilities} onDirtyChange={setExtensionDirty} onPrintMessages={printMessages} onSetSendButtonsEnabled={setSendButtonsEnabled} selection={extensionSelection} generationState={extensionGeneration} onRegisterPromptSource={cap("clientExtensionPrompts") ? registerPromptSource : undefined}/>}
        {extensionSendingDisabled && <p role="status" className="resource-help">{t("An extension has disabled sending and reply alternatives.")}</p>}
        <div ref={rows} className="transcript-rows">{page?.messages.filter(row => typeof row.mes === "string").map(row => {
          const view = page.views?.find(item => item.index === row.index), display = rendered ? (group ? view?.display : row.native_display) ?? row.mes : row.mes;
          return <article className={`transcript-row ${row.is_user ? "user-message" : ""}`} key={row.index}><div className="resource-actions"><strong>{row.name || (row.is_user ? t("You") : target.name)}</strong><span className="resource-help">#{row.index}{row.is_system ? t(" · system") : ""}</span></div>{edit?.message.index === row.index ? <><label className="field">{t("Raw message text")}<textarea className="resource-text" value={edit.text} onChange={event => setEdit({ ...edit, text: event.target.value })}/></label><div className="resource-actions"><button className="secondary-btn" disabled={busy} onClick={() => setEdit(null)}>{t("Cancel edit")}</button><button className="primary-btn" disabled={transcriptBusy} onClick={() => void mutate("edit", edit.message, edit.text)}>{t("Save message")}</button></div></> : <div className="message-text">{display}</div>}{row.extra?.reasoning != null && <details><summary>{t("Stored reasoning")}</summary><pre className="safe-pre">{String(row.extra.reasoning)}</pre></details>}{rendered && (view?.displayReasoning ?? row.native_display_reasoning) && <details><summary>{t("Display reasoning")}</summary><pre className="safe-pre">{view?.displayReasoning ?? row.native_display_reasoning}</pre></details>}<div className="resource-actions">{(group ? cap("groupChatMessageEdit") : cap("chatMutate")) && <button className="secondary-btn" disabled={transcriptBusy || Boolean(edit)} onClick={() => setEdit({ message: row, text: row.mes ?? "" })}>{t("Edit raw")}</button>}{(group ? cap("groupChatMessageDelete") : cap("chatMutate")) && <button className="secondary-btn" disabled={transcriptBusy || Boolean(edit)} onClick={() => void mutate("delete", row)}>{t("Delete")}</button>}{row.swipes && row.swipes.length > 1 && (group ? cap("groupChatSwipe") : capabilities.features?.swipes === true) && <label className="field">{t("Reply alternative")}<select disabled={extensionSendingDisabled || transcriptBusy || Boolean(edit)} value={row.swipe_id ?? 0} onChange={event => void mutate("swipe", row, undefined, Number(event.target.value))}>{row.swipes.map((_swipe, index) => <option key={index} value={index}>{t("{current} / {total}", { current: index + 1, total: row.swipes!.length })}</option>)}</select></label>}</div>{row.native_regex_warnings != null && <pre className="resource-warning safe-pre">{pretty(row.native_regex_warnings)}</pre>}</article>;
        })}</div>{page?.warnings && <pre className="resource-warning safe-pre">{pretty(page.warnings)}</pre>}
      </>}
      {settingTabs.filter(item => item.show && item.id === tab).map(item => <DocumentEditor key={resource(item.name)} title={t(item.label)} path={resource(item.name)} keys={item.keys} limit={item.id === "variables" ? 8_388_608 : 1_048_576} onDirtyChange={setEditorDirty} readOnly={transcriptBusy} help={t(item.id === "sampling" ? "Only saved per-chat overrides: model, maxTokens, temperature, topP, frequencyPenalty, presencePenalty and stop. Empty overrides inherit server settings." : item.id === "world" ? "Set name to a native book name; empty string clears this chat binding." : "Chat-local variables only. Saving never executes macros.")}/>)}
      {tab === "outcomes" && <section><h3>{t("Generation records")}</h3><div className="resource-actions"><label className="field">{t("Recover by caller ID")}<input value={lookupId} onChange={event => setLookupId(event.target.value)} placeholder="st-client-…"/></label><button className="secondary-btn" disabled={busy || Boolean(watch) || !lookupId.trim()} onClick={() => void lookupCaller()}>{t("Look up caller ID")}</button></div>{records.map(item => <div className="resource-actions outcome-row" key={item.requestId}><code>{item.clientRequestId || item.requestId}</code><span>{t(item.status)}{item.committed ? t(" · committed") : ""}</span><button className="secondary-btn" disabled={busy} onClick={() => void inspectRecord(item.requestId)}>{t("Inspect / observe")}</button></div>)}{nextRecord && <button className="secondary-btn" disabled={busy} onClick={() => void run(async () => { const params = new URLSearchParams({ characterId: target.id, chatId, targetKind: target.kind, limit: "20", before: nextRecord }); const next = await api<Data>(`/generations?${params}`); setRecords(previous => [...previous, ...next.generations]); setNextRecord(next.nextBefore); })}>{t("Older records")}</button>}</section>}
      {pending.length > 0 && <div className="resource-warning"><h3>{t("Saved caller IDs — no automatic replay")}</h3>{pending.map(item => <div className="outcome-row" key={item.clientRequestId}><code>{item.clientRequestId}</code><div className="resource-actions"><button className="secondary-btn" disabled={busy} onClick={() => void inspectPending(item)}>{t("Inspect caller ID")}</button>{inspectedMissing === item.clientRequestId && gen("durableAdmission") && <button className="secondary-btn" disabled={busy || Boolean(watch)} onClick={() => void abandon(item)}>{t("Permanently abandon key")}</button>}</div></div>)}</div>}
      {unresolved && <p className="resource-warning">{t("This chat has unresolved generation work. Inspect or observe it in Generation recovery before sending again.")}</p>}
      {record && <section className="generation-observation"><div className="resource-actions"><h3>{t(record.status)} · {record.committed ? t("committed") : t("not committed")}</h3><code>{t("seq {seq}", { seq: record.seq })}</code>{watch && gen("cancel") && <button className="secondary-btn danger-button" disabled={busy} onClick={() => void run(async () => { await api(`/generations/${encode(watch)}/cancel`, { method: "POST", body: "{}" }); setMessage("Cancellation requested; keep observing until the worker drains."); })}>{t("Request cancellation")}</button>}</div><p className="resource-help">{record.clientRequestId ?? record.requestId}</p><pre className="safe-pre">{record.text}</pre>{record.reasoning && <details><summary>{t("Generation reasoning")}</summary><pre className="safe-pre">{record.reasoning}</pre></details>}{record.error && <pre className="resource-warning safe-pre">{pretty(record.error)}</pre>}{record.usage && <details open><summary>{t("Backend-reported usage")}</summary><pre className="safe-pre">{pretty(record.usage)}</pre></details>}{record.toolCalls?.length > 0 && <details><summary>{t("Tool proposals (observation only)")}</summary><pre className="safe-pre">{pretty(record.toolCalls)}</pre></details>}{record.warnings && <pre className="resource-warning safe-pre">{pretty(record.warnings)}</pre>}{record.drained === true && terminal(record.status) && !record.acknowledged && gen("acknowledgeUnknown") && <><label className="check-field"><input type="checkbox" disabled={Boolean(watch) || busy} checked={reviewed === `${record.requestId}:${record.seq}`} onChange={event => setReviewed(event.target.checked ? `${record.requestId}:${record.seq}` : "")}/>{t("I reviewed this exact outcome. Local observation has stopped; acknowledge sequence {seq} without replay.", { seq: record.seq })}</label><button className="secondary-btn" disabled={busy || Boolean(watch) || reviewed !== `${record.requestId}:${record.seq}`} onClick={() => void acknowledge()}>{t("Acknowledge inspected outcome")}</button></>}</section>}
      {preview && <details open className="preview-panel"><summary>{t("Read-only prompt preview")}</summary><pre className="safe-pre">{pretty(preview)}</pre></details>}
      <div className="generation-composer"><label className="field">{type === "quiet" ? t("Quiet instruction (output is not committed)") : t("Message / draft")}<textarea className="resource-text" value={draft} disabled={busy || Boolean(watch)} onChange={event => { setDraft(event.target.value); setPreview(null); }}/></label><div className="resource-actions"><label className="field">{t("Generation type")}<select value={type} disabled={busy || Boolean(watch)} onChange={event => { setType(event.target.value); setPreview(null); }}>{generationModes.map(mode => <option key={mode} value={mode}>{t(mode)}</option>)}</select></label>{group && cap("groupChatPreview") && <label className="field">{t("Preview member")}<select disabled={busy} value={member} onChange={event => setMember(event.target.value)}>{target.members?.map(avatar => <option key={avatar} value={avatar.replace(/\.png$/, "")}>{avatar}</option>)}</select></label>}{(group ? cap("groupChatPreview") : gen(type === "normal" || type === "quiet" ? "preview" : `preview${type[0].toUpperCase()}${type.slice(1)}`)) && <button className="secondary-btn" disabled={busy || Boolean(edit) || (group && !member)} onClick={() => void previewGeneration()}>{t("Preview")}</button>}<button className="primary-btn" disabled={blocked || Boolean(edit) || !generationModes.includes(type) || (type === "normal" && !draft.trim())} onClick={() => void send()}>{watch ? t("Observing…") : t("Generate")}</button></div></div>
    </>}</section></div></div>;
}
