"use client";

import { useEffect, useState } from "react";
import { createApiClient } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { enabled, type Capabilities } from "@/lib/workspace";
import { useDraftGuard } from "./document-editor";
import { Check, Database, Eye, EyeOff, KeyRound, LoaderCircle, Save, Search, ShieldCheck, Trash2, X } from "lucide-react";

type SettingsPayload = { raw?: { oai_settings?: Record<string, unknown> }; typed?: { oai_settings?: Record<string, unknown> } };
const DEFAULT_CUSTOM_URL = "https://api.openai.com/v1";
type SettingsError = { message: string; local: boolean };
const settingsError = (error: unknown, fallback: string): SettingsError => error instanceof Error ? { message: error.message, local: false } : { message: fallback, local: true };
type CatalogModel = { id: string; name: string; contextWindow?: number; maxTokens?: number };

export function ApiSettings({ capabilities, onDirtyChange }: { capabilities: Capabilities; onDirtyChange: (dirty: boolean) => void }) {
  const { t, locale } = useI18n();
  const [api] = useState(createApiClient);
  const [model, setModel] = useState("");
  const [customUrl, setCustomUrl] = useState(DEFAULT_CUSTOM_URL);
  const [context, setContext] = useState(4095);
  const [maxTokens, setMaxTokens] = useState(300);
  const [configured, setConfigured] = useState(false);
  const [legacyOpenAiKey, setLegacyOpenAiKey] = useState(false);
  const [modelDialog, setModelDialog] = useState(false);
  const [catalogModels, setCatalogModels] = useState<CatalogModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<SettingsError | null>(null);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [modelMetadataLabel, setModelMetadataLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<SettingsError | null>(null);
  const [baseline, setBaseline] = useState("");
  const [providerStatus, setProviderStatus] = useState("unchecked");
  const [checkingProvider, setCheckingProvider] = useState(false);
  useDraftGuard(Boolean(apiKey) || Boolean(baseline && baseline !== JSON.stringify([model, customUrl, context, maxTokens])), onDirtyChange);

  useEffect(() => {
    let active = true;
    Promise.all([api<SettingsPayload>("/settings"), enabled(capabilities, "resources", "providerCredentials") ? api<{ openaiConfigured?: boolean; customConfigured?: boolean }>("/provider-credentials") : Promise.resolve({ openaiConfigured: false, customConfigured: false })])
      .then(([settings, credentialState]) => {
        if (!active) return;
        const oai = settings.typed?.oai_settings ?? settings.raw?.oai_settings ?? {};
        setModel(String(oai.custom_model ?? oai.openai_model ?? ""));
        setCustomUrl(String(oai.custom_url ?? DEFAULT_CUSTOM_URL));
        setContext(Number(oai.openai_max_context ?? 4095));
        setMaxTokens(Number(oai.openai_max_tokens ?? 300));
        setBaseline(JSON.stringify([String(oai.custom_model ?? oai.openai_model ?? ""), String(oai.custom_url ?? DEFAULT_CUSTOM_URL), Number(oai.openai_max_context ?? 4095), Number(oai.openai_max_tokens ?? 300)]));
        setConfigured(credentialState.customConfigured === true);
        setLegacyOpenAiKey(credentialState.openaiConfigured === true);
      })
      .catch(e => { if (active) setError(settingsError(e, "Could not load API settings.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [capabilities, api]);

  useEffect(() => {
    if (!enabled(capabilities, "resources", "providerStatus")) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const observe = async () => {
      try {
        const value = await api<{ state: string }>("/provider-status", { signal: abort.signal });
        if (!abort.signal.aborted) setProviderStatus(value.state);
      } catch { if (!abort.signal.aborted) setProviderStatus("unchecked"); }
      if (!abort.signal.aborted) timer = setTimeout(() => { void observe(); }, 5000);
    };
    void observe();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [capabilities, api]);

  const checkConnection = async () => {
    setCheckingProvider(true); setProviderStatus("checking"); setError(null); setMessage("");
    try {
      const result = await api<{ state: string }>("/provider-status/check", { method: "POST", body: "{}" });
      setProviderStatus(result.state);
    } catch (cause) { setProviderStatus("failed"); setError(settingsError(cause, "Could not check the provider connection.")); }
    finally { setCheckingProvider(false); }
  };

  const saveSettings = async () => {
    setSavingSettings(true); setError(null); setMessage("");
    try {
      let url: URL;
      try { url = new URL(customUrl.trim()); } catch { setError({ message: "Enter an absolute custom base URL.", local: true }); return; }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) { setError({ message: "Custom Base URL must use HTTP(S), without credentials, query, or fragment.", local: true }); return; }
      await api("/settings", { method: "PATCH", body: JSON.stringify({ oai_settings: {
        chat_completion_source: "custom",
        custom_url: customUrl.trim(),
        custom_model: model.trim(),
        openai_max_context: context,
        openai_max_tokens: maxTokens,
      } }) });
      setMessage("Custom endpoint settings saved.");
      setProviderStatus("unchecked");
      setBaseline(JSON.stringify([model, customUrl, context, maxTokens]));
    } catch (e) { setError(settingsError(e, "Could not save model settings.")); }
    finally { setSavingSettings(false); }
  };

  const saveKey = async () => {
    if (!apiKey.trim()) { setError({ message: "Enter an API key first.", local: true }); return; }
    setSavingKey(true); setError(null); setMessage("");
    try {
      await api("/provider-credentials", { method: "PUT", body: JSON.stringify({ provider: "custom", apiKey }) });
      setConfigured(true);
      setProviderStatus("unchecked");
      setApiKey(""); setMessage("API key saved securely on the SillyTavern server.");
    } catch (e) { setError(settingsError(e, "Could not save the API key.")); }
    finally { setSavingKey(false); }
  };

  const deleteKey = async () => {
    if (!window.confirm(t("Delete all API keys saved for this custom endpoint? This cannot be undone."))) return;
    setError(null); setMessage("");
    try {
      await api("/provider-credentials/custom", { method: "DELETE" });
      setConfigured(false);
      setProviderStatus("unchecked");
      setApiKey(""); setMessage("Custom endpoint keys deleted.");
    } catch (e) { setError(settingsError(e, "Could not delete the API key.")); }
  };

  const openModelCatalog = async () => {
    setModelDialog(true); setCatalogSearch(""); setCatalogError(null);
    if (!configured) { setCatalogError({ message: "Save the custom API key before loading models.", local: true }); return; }
    setCatalogLoading(true);
    try {
      const payload = await api<{ models?: CatalogModel[] }>("/provider-models", { method: "POST", body: JSON.stringify({ baseUrl: customUrl }) });
      setCatalogModels(payload.models ?? []);
    } catch (e) { setCatalogError(settingsError(e, "Could not load the model catalog.")); }
    finally { setCatalogLoading(false); }
  };

  const chooseModel = (item: CatalogModel) => {
    setModel(item.id); setModelDialog(false); setModelMetadataLabel("");
    if (item.contextWindow) setContext(item.contextWindow);
    if (item.maxTokens) setMaxTokens(item.maxTokens);
    setModelMetadataLabel(item.contextWindow || item.maxTokens ? "Limits supplied by the V1 provider model catalog." : "The provider did not report limits. Set them manually.");
  };

  const visibleModels = catalogModels.filter(item => `${item.name} ${item.id}`.toLowerCase().includes(catalogSearch.toLowerCase())).slice(0, 150);

  return <div className="settings-page">
    <div className="settings-heading"><div><div className="heading-kicker">{t("SERVER CONFIGURATION")}</div><h1>{t("API settings")}</h1><p>{t("Configure the provider used by your SillyTavern backend.")}</p></div><div className="settings-api-badge"><span className="green-dot"/> API v1</div></div>
    {error && <div className="settings-alert error-alert">{error.local ? t(error.message) : error.message}</div>}
    {message && <div className="settings-alert success-alert"><Check size={14}/>{t(message)}</div>}
    {loading ? <div className="settings-loading"><LoaderCircle size={16} className="spin-icon"/> {t("Loading server settings…")}</div> : <div className="settings-grid">
      <section className="settings-card provider-card">
        <div className="settings-card-head"><div className="provider-symbol">◎</div><div><h2>{t("OpenAI-compatible endpoint")}</h2><p>{t("Base URL and model parameters")}</p></div><span className="supported-tag">{t("SUPPORTED")}</span></div>
        <div className="form-grid">
          <label className="field full-field">{t("Base URL")}<input value={customUrl} onChange={e => setCustomUrl(e.target.value)} placeholder={DEFAULT_CUSTOM_URL} autoComplete="url"/><small>{t("Defaults to OpenAI’s endpoint. The backend appends")} <code>/chat/completions</code>{t(". Never include credentials in the URL.")}</small></label>
          <div className="field full-field"><label htmlFor="custom-model">{t("Model name")}</label><div className="model-picker-row"><input id="custom-model" value={model} onChange={e => { setModel(e.target.value); setModelMetadataLabel(""); }} placeholder="gpt-4o-mini" autoComplete="off"/><button className="catalog-button" type="button" disabled={!enabled(capabilities, "resources", "providerModels")} onClick={() => void openModelCatalog()}><Database size={13}/>{t("Fetch /models")}</button></div><small>{t("Load model IDs through /api/v1/provider-models. Enter any limits not reported by the provider.")}</small>{modelMetadataLabel && <small className="model-metadata-note">{t(modelMetadataLabel)}</small>}</div>
          <label className="field">{t("Context length")}<input type="number" min={1} max={2000000} value={context} onChange={e => setContext(Number(e.target.value))}/></label>
          <label className="field">{t("Max response tokens")}<input type="number" min={1} max={2000000} value={maxTokens} onChange={e => setMaxTokens(Number(e.target.value))}/></label>
        </div>
        <div className="settings-card-foot"><span>{t("Saved to the server’s SillyTavern settings.")}</span><button className="primary-btn" disabled={savingSettings || !enabled(capabilities, "resources", "settingsPatch") || !model.trim() || !context || !maxTokens} onClick={() => void saveSettings()}>{savingSettings ? <LoaderCircle size={14} className="spin-icon"/> : <Save size={14}/>}{t("Save model settings")}</button></div>
        {enabled(capabilities, "resources", "providerStatus") && <div className="settings-card-foot">
          <div><p role="status" data-provider-status={providerStatus}>{t(providerStatus === "valid" ? "Connection check succeeded" : providerStatus === "checking" ? "Checking provider connection…" : providerStatus === "failed" ? "Connection check failed" : "Provider connection not checked")}</p><small>{t("Checks access to the provider’s model catalog using saved settings.")}</small></div>
          <button className="secondary-btn" disabled={checkingProvider || providerStatus === "checking" || savingSettings || savingKey || Boolean(apiKey) || baseline !== JSON.stringify([model, customUrl, context, maxTokens])} onClick={() => void checkConnection()}>{t("Check provider connection")}</button>
        </div>}
      </section>

      {enabled(capabilities, "resources", "providerCredentials") && <section className="settings-card credential-card">
        <div className="settings-card-head"><div className="credential-icon"><KeyRound size={16}/></div><div><h2>{t("Custom endpoint API key")}</h2><p>{t("Stored in the server’s private credential vault")}</p></div></div>
        <div className="credential-state"><span className={`dot ${configured ? "online" : ""}`}/><strong>{configured ? t("Key configured") : t("No key saved")}</strong><span>{configured ? t("The key is never returned by the API.") : t("Add a key to enable provider requests.")}</span></div>
        {legacyOpenAiKey && !configured && <div className="credential-migration-note">{t("An OpenAI key is already stored separately. Re-enter it here to save it for the always-custom provider.")}</div>}
        <label className="field">{configured ? t("Replace API key") : t("Custom endpoint API key")}<div className="secret-input"><input type={showKey ? "text" : "password"} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={configured ? t("Enter a new key to replace") : t("Paste API key")} autoComplete="new-password"/><button className="icon-btn" type="button" aria-label={showKey ? t("Hide API key") : t("Show API key")} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={15}/> : <Eye size={15}/>}</button></div><small>{t("Write-only: the saved value cannot be viewed or recovered here.")}</small></label>
        <div className="credential-actions"><button className="primary-btn" disabled={savingKey || !apiKey.trim()} onClick={() => void saveKey()}>{savingKey ? <LoaderCircle size={14} className="spin-icon"/> : <ShieldCheck size={14}/>}{t("Save key")}</button>{configured && <button className="delete-key-btn" onClick={() => void deleteKey()}><Trash2 size={14}/> {t("Delete all keys")}</button>}</div>
      </section>}
      <div className="settings-privacy"><ShieldCheck size={14}/><span>{t("Keys are sent only to the authenticated V1 credential endpoint and never stored in this browser.")}</span></div>
    </div>}
    {modelDialog && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setModelDialog(false); }}><section className="model-dialog"><div className="model-dialog-head"><div><h2>{t("Choose a model")}</h2><p>{t("Fetched from your custom endpoint’s")} <code>/models</code></p></div><button className="icon-btn" aria-label={t("Close model list")} onClick={() => setModelDialog(false)}><X size={17}/></button></div><div className="model-search"><Search size={15}/><input autoFocus placeholder={t("Search models…")} value={catalogSearch} onChange={e => setCatalogSearch(e.target.value)}/></div>{catalogError && <div className="model-catalog-error">{catalogError.local ? t(catalogError.message) : catalogError.message}<button onClick={() => void openModelCatalog()}>{t("Retry")}</button></div>}{catalogLoading ? <div className="catalog-loading"><LoaderCircle size={16} className="spin-icon"/>{t("Loading models…")}</div> : <div className="model-results">{visibleModels.map(item => <button key={item.id} className="model-option" onClick={() => void chooseModel(item)}><span className="model-option-copy"><strong>{item.name}</strong><code>{item.id}</code></span><span className="model-option-meta">{item.contextWindow && <small>{t("{count} ctx", { count: item.contextWindow.toLocaleString(locale) })}</small>}{item.maxTokens && <small>{t("{count} max", { count: item.maxTokens.toLocaleString(locale) })}</small>}</span></button>)}{!catalogError && !visibleModels.length && <div className="catalog-empty">{t("No matching models.")}</div>}{visibleModels.length === 150 && <div className="catalog-limit">{t("Showing first {count} matches. Refine your search.", { count: (150).toLocaleString(locale) })}</div>}</div>}<div className="model-dialog-foot">{t("The backend fetches this list using the saved key; only model IDs and names are sent to the client.")}</div></section></div>}
  </div>;
}
