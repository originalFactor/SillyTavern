"use client";

import { useI18n } from "@/lib/i18n";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createApiClient } from "@/lib/api";
import { JsonEditor } from "./json-editor";
import { editableDocument, jsonFile, messageOf, objectJson, pretty, revisionBody, type Data } from "@/lib/workspace";

export function useDraftGuard(dirty: boolean, onDirtyChange?: (dirty: boolean) => void) {
  const { t } = useI18n();
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return () => !dirty || window.confirm(t("Discard the unsaved draft?"));
}

export type NoticeError = string | { detail: string; hint: string };

export function Notice({ error, message }: { error?: NoticeError; message?: string }) {
  const { t } = useI18n();
  return <>{error && <div role="alert" className="settings-alert error-alert">{typeof error === "string" ? t(error) : <>{t(error.detail)} {t(error.hint)}</>}</div>}{message && <div role="status" className="settings-alert success-alert">{t(message)}</div>}</>;
}

export function PromptFields({ value, change, disabled }: { value: Data; change: (value: Data) => void; disabled: boolean }) {
  const { t } = useI18n();
  const prompts: Data[] = Array.isArray(value.prompts) ? value.prompts : [], order: Data[] = Array.isArray(value.order) ? value.order : [];
  if (prompts.some(prompt => !prompt || typeof prompt.identifier !== "string") || order.some(entry => !entry || typeof entry.identifier !== "string")) return <p className="resource-warning">{t("Repair prompt identifiers and order in Advanced JSON to use the structured editor.")}</p>;
  const update = (id: string, patch: Data) => change({ ...value, prompts: prompts.map(prompt => prompt.identifier === id ? { ...prompt, ...patch } : prompt) });
  return <div className="prompt-fields"><div className="resource-actions"><h3>{t("Prompt order")}</h3><button disabled={disabled} className="secondary-btn" onClick={() => { const identifier = `prompt-${crypto.randomUUID()}`; change({ ...value, prompts: [...prompts, { identifier, name: "New prompt", role: "system", content: "" }], order: [...order, { identifier, enabled: true }] }); }}>{t("Add prompt")}</button></div>{order.map((entry, index) => {
    const prompt = prompts.find(item => item.identifier === entry.identifier); if (!prompt) return <p key={entry.identifier}>{t("Unresolved:")} {entry.identifier}</p>;
    const move = (offset: number) => { const next = [...order]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; change({ ...value, order: next }); };
    return <details key={entry.identifier} className="prompt-entry"><summary>{prompt.name || prompt.identifier}{prompt.marker ? t(" · marker") : ""}{entry.enabled ? "" : t(" · disabled")}</summary><div className="resource-actions"><label className="check-field"><input type="checkbox" checked={entry.enabled === true} disabled={disabled} onChange={event => change({ ...value, order: order.map((row, rowIndex) => rowIndex === index ? { ...row, enabled: event.target.checked } : row) })}/>{t("Enabled")}</label><button className="secondary-btn" disabled={disabled || index === 0} onClick={() => move(-1)}>{t("Move up")}</button><button className="secondary-btn" disabled={disabled || index === order.length - 1} onClick={() => move(1)}>{t("Move down")}</button>{!prompt.marker && <button className="secondary-btn" disabled={disabled} onClick={() => change({ ...value, prompts: prompts.filter(row => row.identifier !== prompt.identifier), order: order.filter(row => row.identifier !== prompt.identifier) })}>{t("Remove")}</button>}</div><div className="form-grid"><label className="field">{t("Name")}<input value={prompt.name ?? ""} disabled={disabled} onChange={event => update(prompt.identifier, { name: event.target.value })}/></label><label className="field">{t("Role")}<select value={prompt.role ?? "system"} disabled={disabled} onChange={event => update(prompt.identifier, { role: event.target.value })}>{["system", "user", "assistant"].map(role => <option key={role} value={role}>{t(role === "system" ? "System" : role === "user" ? "User" : "Assistant")}</option>)}</select></label><label className="field">{t("Injection")}<select disabled={disabled} value={prompt.injection_position ?? 0} onChange={event => update(prompt.identifier, { injection_position: Number(event.target.value) })}><option value={0}>{t("Relative order")}</option><option value={1}>{t("At depth")}</option></select></label><label className="field">{t("Depth")}<input disabled={disabled} type="number" min={0} max={10000} value={prompt.injection_depth ?? 4} onChange={event => update(prompt.identifier, { injection_depth: Number(event.target.value) })}/></label><label className="field">{t("Priority")}<input disabled={disabled} type="number" min={-10000} max={10000} value={prompt.injection_order ?? 100} onChange={event => update(prompt.identifier, { injection_order: Number(event.target.value) })}/></label></div>{!prompt.marker && <label className="field">{t("Content")}<textarea className="resource-text" disabled={disabled} value={prompt.content ?? ""} onChange={event => update(prompt.identifier, { content: event.target.value })}/></label>}</details>;
  })}</div>;
}

type Props = { title: string; path: string; keys: readonly string[]; help?: string; limit?: number; regex?: boolean; prompts?: boolean; readOnly?: boolean; method?: "PUT" | "PATCH"; revision?: boolean; onDirtyChange?: (dirty: boolean) => void; children?: ReactNode };

export function DocumentEditor({ title, path, keys, help, limit = 1_048_576, regex = false, prompts = false, readOnly = false, method = "PUT", revision = true, onDirtyChange, children }: Props) {
  const { t } = useI18n();
  const [api] = useState(createApiClient);
  const [document, setDocument] = useState<Data | null>(null), [text, setText] = useState("{}"), [baseline, setBaseline] = useState("{}");
  const [busy, setBusy] = useState(false), [error, setError] = useState<NoticeError>(""), [message, setMessage] = useState("");
  const [grant, setGrant] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const dirty = text !== baseline, discard = useDraftGuard(dirty, onDirtyChange);
  const apply = (next: Data) => { const value = pretty(editableDocument(next, keys)); setDocument(next); setText(value); setBaseline(value); setGrant(false); };
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setDocument(null); setError("");
    api<Data>(path, { signal: controller.signal }).then(next => { if (!controller.signal.aborted) apply(next); }).catch(e => { if (!controller.signal.aborted) setError(messageOf(e)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
    // Editors are keyed by resource path; field ownership does not change in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  const reload = async () => { if (!discard()) return; setBusy(true); setError(""); setMessage(""); try { apply(await api<Data>(path)); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); } };
  const save = async () => {
    if (!document) return; setBusy(true); setError(""); setMessage("");
    try {
      const draft = objectJson(text, limit);
      const body = revision ? revisionBody(document, draft, keys) : draft.settings;
      if (regex && grant) body.confirmScopeChanges = true;
      const next = await api<Data>(path, { method, body: JSON.stringify(body) }); apply(next); setMessage("Saved.");
    } catch (e) { setError({ detail: messageOf(e), hint: "Draft retained. Inspect current server state before retrying; no automatic overwrite was attempted." }); }
    finally { setBusy(false); }
  };
  let value: Data | null = null; try { value = objectJson(text, limit); } catch { /* Keep invalid JSON editable. */ }
  const change = (next: Data) => { setText(pretty(next)); setGrant(false); };
  return <section className="settings-card document-editor" aria-busy={busy}><div className="resource-actions"><div><h2>{title}</h2>{help && <p className="resource-help">{help}</p>}</div><button className="secondary-btn" disabled={busy} onClick={() => void reload()}>{t("Reload")}</button></div><Notice error={error} message={message}/>{children}
    {document && <><p className="resource-help">{revision ? t("Revision checked. Conflicts require explicit reload; drafts are never retried automatically.") : t("This endpoint merges settings without revision checks. Review carefully before saving.")}</p>{prompts && value && <PromptFields value={value} change={change} disabled={busy || readOnly}/>}{value && typeof value.experimental === "boolean" && <label className="check-field"><input type="checkbox" checked={value.experimental} disabled={busy || readOnly} onChange={event => change({ ...value, experimental: event.target.checked })}/>{t("Use the new macro engine")}</label>}
      {prompts ? <details className="advanced-json"><summary>{t("All prompt fields and generation triggers")}</summary><JsonEditor text={text} onChange={next => { setText(next); setGrant(false); }} disabled={busy || readOnly} label={title}/></details> : <JsonEditor text={text} onChange={next => { setText(next); setGrant(false); }} disabled={busy || readOnly} label={title}/>}
      {regex && <div className="resource-warning"><p>{t("Review every characterAllowed and presetAllowed scope in the draft. Grants cover future edits to those named cards/presets.")}</p><label className="check-field"><input type="checkbox" checked={grant} disabled={busy || readOnly} onChange={event => setGrant(event.target.checked)}/>{t("I explicitly authorize the scopes listed in this draft.")}</label></div>}
      <div className="resource-actions"><span className="resource-help">{dirty ? t("Unsaved draft") : t("Inspected document")}</span><button className="secondary-btn" disabled={busy || readOnly} onClick={() => input.current?.click()}>{t("Import JSON draft")}</button><button className="secondary-btn" disabled={busy || !value} onClick={() => { if (value) setText(pretty(value)); }}>{t("Format JSON")}</button><button className="primary-btn" disabled={busy || readOnly || !dirty} onClick={() => void save()}>{t("Save")}</button></div>
      <input hidden ref={input} type="file" accept=".json,application/json" onChange={async event => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; setBusy(true); try { const next = await jsonFile(file, limit); if (discard()) { change(next); setMessage("Imported as a draft. Review before saving; import grants no regex scopes."); setError(""); } } catch (e) { setError(messageOf(e)); } finally { setBusy(false); } }}/></>}
  </section>;
}
