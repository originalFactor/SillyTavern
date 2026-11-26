"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FileJson, LoaderCircle, Play, Plus, RefreshCw, Save, Upload } from "lucide-react";
import { createApiClient } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { downloadFile } from "@/lib/workspace";
import { JsonEditor } from "./json-editor";
import { parsePreset, PRESET_KINDS, presetPath, presetSaveBody, readPresetFile, type PresetCatalog, type PresetDocument, type PresetKind } from "@/lib/presets";

const format = (document: PresetDocument) => JSON.stringify(document.preset, null, 2);
type PresetError = { message: string; local: boolean; hint?: string };
const errorMessage = (error: unknown, local = false, hint?: string): PresetError => ({ message: error instanceof Error ? error.message : "The preset operation failed.", local: local || !(error instanceof Error), hint });

export function PresetSettings({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { t, locale } = useI18n();
  const [api] = useState(createApiClient);
  const [kind, setKind] = useState<PresetKind>("chat-completion");
  const [catalog, setCatalog] = useState<PresetCatalog | null>(null);
  const [document, setDocument] = useState<PresetDocument | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("{}");
  const [baseline, setBaseline] = useState({ name: "", text: "{}" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PresetError | null>(null);
  const [message, setMessage] = useState("");
  const [allowConnectionChanges, setAllowConnectionChanges] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty = name !== baseline.name || text !== baseline.text;
  const saved = document !== null && name === document.name && !dirty;
  // Translate only this local validator; API errors remain verbatim.
  const validatePreset = useCallback((value: string) => {
    try { return parsePreset(value); }
    catch (error) { throw new Error(t(errorMessage(error, true).message)); }
  }, [t]);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const setInspected = (next: PresetDocument | null) => {
    const nextName = next?.name ?? "", nextText = next ? format(next) : "{}";
    setDocument(next); setName(nextName); setText(nextText);
    setBaseline({ name: nextName, text: nextText }); setAllowConnectionChanges(false);
  };

  // Cancel an obsolete read when the kind changes or this view is unmounted.
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setBusy(true); setError(null); setMessage(""); setCatalog(null); setInspected(null);
      try {
        const next = await api<PresetCatalog>(presetPath(kind), { signal: controller.signal });
        const entry = next.presets.find(item => item.name === next.activeName) ?? next.presets[0];
        const inspected = entry ? await api<PresetDocument>(presetPath(kind, entry.name), { signal: controller.signal }) : null;
        if (controller.signal.aborted) return;
        setCatalog(next); setInspected(inspected);
      } catch (e) { if (!controller.signal.aborted) setError(errorMessage(e)); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    };
    void load();
    return () => controller.abort();
  }, [kind, api]);

  const discard = () => !dirty || window.confirm(t("Discard your unsaved preset draft?"));
  const inspect = async (targetName?: string) => {
    if (!discard()) return;
    setBusy(true); setError(null); setMessage("");
    try {
      const next = await api<PresetCatalog>(presetPath(kind));
      const target = targetName ?? document?.name ?? next.presets.find(item => item.name === next.activeName)?.name ?? next.presets[0]?.name;
      const inspected = target ? await api<PresetDocument>(presetPath(kind, target)) : null;
      setCatalog(next); setInspected(inspected);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  const importFile = async (file: File) => {
    setBusy(true); setError(null); setMessage("");
    try {
      const imported = await readPresetFile(file);
      if (!discard()) return;
      setName(imported.name); setText(imported.text); setAllowConnectionChanges(false);
      setMessage("JSON imported as a draft. Check the preset type, name and contents, then save. Saving does not activate it.");
    } catch (e) { setError(errorMessage(e, true)); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setError(null); setMessage("");
    let validating = true;
    try {
      const body = presetSaveBody(name, text, document);
      validating = false;
      const next = await api<PresetDocument>(presetPath(kind, name), { method: "PUT", body: JSON.stringify(body) });
      setInspected(next);
      setCatalog(previous => previous ? { ...previous, presets: [...previous.presets.filter(item => item.name !== next.name), { name: next.name, origin: next.origin, revision: next.revision }].sort((a, b) => a.name.localeCompare(b.name)) } : previous);
      setMessage("Preset saved. Use Activate to apply it to the active configuration.");
    } catch (e) { setError(errorMessage(e, validating, "Your draft has been kept. If the name exists or its revision changed, inspect it before replacing it. Reload discards the draft.")); }
    finally { setBusy(false); }
  };

  const activate = async () => {
    if (!document || !catalog || !saved) return;
    setBusy(true); setError(null); setMessage("");
    try {
      const next = await api<PresetCatalog>(`${presetPath(kind, document.name)}/activate`, { method: "POST", body: JSON.stringify({ expectedRevision: document.revision, expectedActiveRevision: catalog.activeRevision, allowConnectionChanges }) });
      setCatalog(next); setAllowConnectionChanges(false);
      setMessage("Preset activated.");
    } catch (e) { setError(errorMessage(e, false, "Reload to inspect the latest preset and active configuration before trying again.")); }
    finally { setBusy(false); }
  };

  const exportSaved = async () => {
    if (!document || !saved) return; setBusy(true); setError(null);
    try { downloadFile(await api(`${presetPath(kind, document.name)}/export`)); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const deleteSaved = async () => {
    if (!document || !saved || !window.confirm(t("Delete user preset {name}? A bundled original, if present, will become visible again.", { name: document.name }))) return;
    setBusy(true); setError(null); setMessage("");
    try { await api(`${presetPath(kind, document.name)}?expectedRevision=${encodeURIComponent(document.revision)}`, { method: "DELETE" }); setInspected(null); setMessage("User preset deleted."); setCatalog(await api<PresetCatalog>(presetPath(kind))); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const copyActive = async () => {
    if (!discard()) return; setBusy(true); setError(null); setMessage("");
    try { const active = await api<{ name: string; preset: Record<string, unknown> }>(`/preset-settings/${kind}`); setInspected(null); setName(t("{name} copy", { name: active.name || t("Active") })); setText(JSON.stringify(active.preset, null, 2)); setMessage("Active configuration copied to a portable draft. Choose a new name and save."); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  return <div className="settings-page preset-page" aria-busy={busy}>
    <div className="settings-heading"><div><div className="heading-kicker">{t("PROMPTS & TEMPLATES")}</div><h1>{t("Presets")}</h1><p>{t("Edit or import SillyTavern JSON presets. Save first, then activate.")}</p></div><FileJson size={22}/></div>
    {error && <div className="settings-alert error-alert" role="alert">{error.local ? t(error.message) : error.message}{error.hint && <> {t(error.hint)}</>}</div>}
    {message && <div className="settings-alert success-alert" role="status"><Check size={14}/>{t(message)}</div>}
    <div className="preset-toolbar">
      <label className="field">{t("Preset type")}<select value={kind} disabled={busy} onChange={event => { if (discard()) setKind(event.target.value as PresetKind); }}>{PRESET_KINDS.map(item => <option key={item.id} value={item.id}>{t(item.label)}</option>)}</select></label>
      <div className="preset-actions">
        <button className="secondary-btn" disabled={busy} onClick={() => void inspect()}><RefreshCw size={14}/>{t("Reload")}</button>
        <button className="secondary-btn" disabled={busy || !catalog} onClick={() => { if (discard()) { setInspected(null); setError(null); setMessage(""); } }}><Plus size={14}/>{t("New")}</button>
        <button className="secondary-btn" disabled={busy || !catalog} onClick={() => fileInput.current?.click()}><Upload size={14}/>{t("Import JSON")}</button>
        <button className="secondary-btn" disabled={busy || !catalog} onClick={() => void copyActive()}>{t("Copy active settings")}</button>
        <button className="secondary-btn" disabled={busy || !saved} onClick={() => void exportSaved()}>{t("Export")}</button>
        <button className="secondary-btn danger-button" disabled={busy || !saved || document?.origin !== "user" || document?.name === catalog?.activeName} onClick={() => void deleteSaved()}>{t("Delete")}</button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label={t("Import preset JSON file")} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file); }}/>
      </div>
    </div>
    {busy && <div className="preset-progress" role="status"><LoaderCircle size={14} className="spin-icon"/>{t("Working…")}</div>}
    {catalog && <div className="preset-layout">
      <aside className="settings-card preset-list" aria-label={t("Saved presets")}><h2>{t("Saved presets")}</h2><p>{t("Active:")} <strong>{catalog.activeName || t("None")}</strong></p><div className="preset-list-items">{catalog.presets.map(item => <button key={item.name} className={`preset-item ${document?.name === item.name ? "selected" : ""}`} disabled={busy} onClick={() => void inspect(item.name)}><span>{item.name}</span><small>{item.origin === "builtin" ? t("Built-in") : t("User")}{item.name === catalog.activeName ? t(" · Active") : ""}</small></button>)}{!catalog.presets.length && <p>{t("No saved presets. Create one or import JSON.")}</p>}</div>{catalog.warnings.map(warning => <p className="preset-warning" key={warning.name}>{warning.name}: {warning.message}</p>)}</aside>
      <section className="settings-card preset-editor" aria-label={t("Preset editor")}>
        <div className="preset-editor-heading"><h2>{document?.name === name ? t("Edit preset") : t("New preset / save a copy")}</h2><span>{dirty ? t("Unsaved draft") : document ? t("Saved revision") : t("New draft")}</span></div>
        <label className="field">{t("Preset name")}<input value={name} disabled={busy} onChange={event => { setName(event.target.value); setAllowConnectionChanges(false); }} placeholder={t("My preset")} autoComplete="off"/><small>{t("Change the name to save a copy. To replace an existing name, inspect that preset first.")}</small></label>
        {document?.origin === "builtin" && document.name === name && <p className="preset-note">{t("Saving creates a user override of this built-in preset.")}</p>}
        {document?.credentialsRedacted && <p className="preset-warning">{t("This preset contains redacted credentials. Remove credential fields and custom headers before saving. Configure keys in API settings.")}</p>}
        <JsonEditor text={text} disabled={busy} label={t("Preset")} validate={validatePreset} onChange={next => { setText(next); setAllowConnectionChanges(false); }}/>
        <button className="secondary-btn" disabled={busy} onClick={() => { try { setText(JSON.stringify(parsePreset(text), null, 2)); setError(null); } catch (e) { setError(errorMessage(e, true)); } }}>{t("Format JSON")}</button>
        <p className="preset-note">{t("UTF-8 JSON object, up to {size} MiB. Unknown fields are preserved. Imported files are not applied automatically; keys and custom headers must be configured separately.", { size: (1).toLocaleString(locale) })}</p>
        {document?.compatibilityWarnings.map((warning, index) => <p className="preset-warning" key={`${warning.identifier}-${index}`}>{t("Unresolved prompt order entry: {identifier}. Its content is unavailable and will be skipped.", { identifier: warning.identifier })}</p>)}
        {saved && document.connectionChanges.length > 0 && <div className="preset-connection-review"><strong>{t("Connection changes")}</strong><p>{t("Review the source, model and endpoint fields before activation.")}</p><pre>{JSON.stringify(document.connectionSettings, null, 2)}</pre><label><input type="checkbox" checked={allowConnectionChanges} disabled={busy} onChange={event => setAllowConnectionChanges(event.target.checked)}/>{t("I approve these connection changes.")}</label></div>}
        <div className="settings-card-foot"><span>{dirty ? t("Save your draft before activation.") : t("Saving and activation are separate operations.")}</span><div className="preset-actions"><button className="secondary-btn" disabled={busy || !saved || (document.connectionChanges.length > 0 && !allowConnectionChanges)} onClick={() => void activate()}><Play size={14}/>{t("Activate")}</button><button className="primary-btn" disabled={busy || !name.trim() || (!dirty && document !== null)} onClick={() => void save()}><Save size={14}/>{document?.name === name ? t("Save changes") : t("Save preset")}</button></div></div>
      </section>
    </div>}
  </div>;
}
