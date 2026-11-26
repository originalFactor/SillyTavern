"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createApiClient } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { messageOf } from "@/lib/workspace";
import { bulkPlan, installPlan, packageKey, packageRequest, type PackageInventory, type PackageKind, type PackageOutcome, type PackagePlan } from "@/lib/package-management";
import { Notice } from "./document-editor";

export function PluginManagement({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { t } = useI18n();
  const [api] = useState(createApiClient);
  const [inventory, setInventory] = useState<PackageInventory | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [kind, setKind] = useState<PackageKind>("extension");
  const [name, setName] = useState(""), [url, setUrl] = useState("");
  const [filter, setFilter] = useState(""), [typeFilter, setTypeFilter] = useState<"all" | PackageKind>("all");
  const [plan, setPlan] = useState<PackagePlan | null>(null), [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [outcome, setOutcome] = useState<PackageOutcome | null>(null);
  const [needsReload, setNeedsReload] = useState(false), [restartRequired, setRestartRequired] = useState(false);
  const lock = useRef(false);
  const draft = Boolean(name || url || plan);
  useEffect(() => { onDirtyChange(busy || draft); return () => onDirtyChange(false); }, [busy, draft, onDirtyChange]);
  useEffect(() => {
    if (!busy && !draft) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [busy, draft]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const next = await api<PackageInventory>("/package-management", { signal });
    setInventory(next); setSelected(new Set()); setNeedsReload(false);
  }, [api]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(e => { if (!controller.signal.aborted) setError(messageOf(e)); });
    return () => controller.abort();
  }, [load]);
  async function reload() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setPlan(null); setTrusted(false);
    try { await load(); } catch (e) { setError(messageOf(e)); setNeedsReload(true); }
    finally { lock.current = false; setBusy(false); }
  }
  const ready = Boolean(inventory?.enabled && inventory.revision && !busy && !needsReload && !plan);
  const manageable = inventory?.packages.filter(item => item.manageable) ?? [];
  const visible = (inventory?.packages ?? []).filter(item => (typeFilter === "all" || item.kind === typeFilter) && `${item.name} ${item.repository ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  const visibleManageable = visible.filter(item => item.manageable);
  const allSelected = visibleManageable.length > 0 && visibleManageable.every(item => selected.has(packageKey(item)));
  const selectedCount = manageable.filter(item => selected.has(packageKey(item))).length;
  const stage = (next: PackagePlan) => { setError(""); setOutcome(null); setTrusted(false); setPlan(next); };
  const stageBulk = (action: "upgrade" | "remove", keys = selected) => {
    try { stage(bulkPlan(action, inventory?.packages ?? [], keys)); } catch (e) { setError(messageOf(e)); }
  };
  async function execute() {
    if (lock.current || !plan || !trusted || !inventory?.enabled || needsReload) return;
    const request = packageRequest(plan, inventory.revision);
    lock.current = true; setBusy(true); setError(""); setOutcome(null);
    try {
      const result = await api<PackageOutcome>(request.path, { method: "POST", body: JSON.stringify(request.body), timeoutMs: 120_000 });
      setOutcome(result); setRestartRequired(previous => previous || result.restartRequired);
      if (plan.action === "install" && result.results.some(item => item.ok)) { setName(""); setUrl(""); }
      setPlan(null); setTrusted(false);
      // Only refresh observation. Never repeat a mutation after an error or timeout.
      setNeedsReload(true);
      try { await load(); } catch (e) { setError(messageOf(e)); }
    } catch (e) {
      setError(messageOf(e)); setNeedsReload(true); setPlan(null); setTrusted(false);
    } finally { lock.current = false; setBusy(false); }
  }
  const kindLabel = (value: PackageKind) => value === "extension" ? t("Extension") : t("Server plugin");
  const actionLabel = plan?.action === "install" ? t("Install plugin") : plan?.action === "upgrade" ? t("Upgrade plugins") : t("Remove plugins");

  return <div className="settings-page plugin-management" aria-busy={busy}>
    <div className="settings-heading"><div><h1>{t("Plugin management")}</h1><p>{t("Install and maintain extensions and trusted server plugins. Settings and extension interfaces remain in Extensions.")}</p></div><button className="secondary-btn" disabled={busy} onClick={() => void reload()}>{t("Reload inventory")}</button></div>
    <Notice error={t(error)}/>
    {restartRequired && <p role="status" className="resource-warning">{t("Plugin files changed. Restart the backend before using the changed plugins. This page does not restart or hot-load code.")}</p>}
    {needsReload && <p role="alert" className="resource-warning">{t("The inventory may have changed. Inspect server state and reload inventory before another action. No request will be automatically retried.")}</p>}
    {inventory && !inventory.enabled && <p className="resource-warning">{t("Plugin management is disabled by the server operator.")}</p>}
    {inventory?.diagnostics?.map((detail, index) => <p key={index} className="resource-warning">{detail}</p>)}
    <section className="settings-card plugin-install" aria-labelledby="plugin-install-title">
      <h2 id="plugin-install-title">{t("Install plugin")}</h2>
      <p className="resource-help">{t("Use a trusted HTTPS Git repository. Installation does not run package scripts or install dependencies. New extensions are installed disabled; server plugins are trusted Node code that may execute after a restart.")}</p>
      <form onSubmit={event => { event.preventDefault(); if (!ready) return; try { stage(installPlan(kind, name, url)); } catch (e) { setError(messageOf(e)); } }}>
        <fieldset disabled={!ready} className="plugin-install-fields"><legend className="sr-only">{t("Install plugin")}</legend>
          <label className="field">{t("Plugin type")}<select value={kind} onChange={event => setKind(event.target.value as PackageKind)}><option value="extension">{t("Extension")}</option><option value="server-plugin">{t("Server plugin")}</option></select></label>
          <label className="field">{t("Folder name")}<input value={name} maxLength={64} onChange={event => setName(event.target.value)} autoComplete="off" placeholder="my-plugin" required/></label>
          <label className="field plugin-repository">{t("Git repository URL")}<input type="url" value={url} onChange={event => setUrl(event.target.value)} autoComplete="off" placeholder="https://github.com/owner/plugin.git" required/></label>
          <button className="primary-btn" type="submit" disabled={!name.trim() || !url.trim()}>{t("Review installation")}</button>
        </fieldset>
      </form>
    </section>
    {plan && <section className="settings-card plugin-confirmation" aria-labelledby="plugin-confirm-title">
      <h2 id="plugin-confirm-title">{actionLabel}</h2>
      {plan.action === "install" ? <p className="safe-pre">{kindLabel(plan.kind)}: <strong>{plan.name}</strong><br/>{plan.url}</p> : <ul>{plan.packages.map(item => <li key={packageKey(item)}>{kindLabel(item.kind)}: <strong>{item.name}</strong></li>)}</ul>}
      <p className="resource-help">{plan.action === "remove" ? t("Remove these plugin folders from the server. Existing settings are retained. Loaded server code stays active until the backend restarts.") : t("Only proceed if you trust this code and its repository maintainers. Plugins can change behavior; server plugins run with backend process permissions. No dependency scripts will run during this operation.")}</p>
      <label className="check-field"><input type="checkbox" checked={trusted} disabled={busy} onChange={event => setTrusted(event.target.checked)}/>{plan.action === "remove" ? t("I confirm removal of exactly these plugins.") : t("I trust these plugins and authorize these file changes.")}</label>
      <div className="resource-actions"><button className="secondary-btn" disabled={busy} onClick={() => { setPlan(null); setTrusted(false); }}>{t("Cancel")}</button><button className={plan.action === "remove" ? "secondary-btn danger-button" : "primary-btn"} disabled={busy || !trusted} onClick={() => void execute()}>{busy ? t("Applying changes…") : actionLabel}</button></div>
    </section>}
    {outcome && <section className="settings-card plugin-results" aria-label={t("Plugin action results")} aria-live="polite"><h2>{t("Plugin action results")}</h2><ul>{outcome.results.map((item, index) => <li key={`${packageKey(item)}:${index}`}><strong>{kindLabel(item.kind)}: {item.name}</strong><span className={item.ok ? "resource-help" : "resource-warning"}>{item.ok ? t("Succeeded") : t("Failed")}: {item.message}</span></li>)}</ul></section>}
    <section className="settings-card" aria-labelledby="plugin-inventory-title">
      <div className="resource-actions"><div><h2 id="plugin-inventory-title">{t("Installed plugins")}</h2><p className="resource-help">{t("Select plugins for bulk actions. Read-only entries cannot be changed by this manager.")}</p></div></div>
      <div className="plugin-filters"><label className="field">{t("Find plugins")}<input type="search" value={filter} onChange={event => setFilter(event.target.value)}/></label><label className="field">{t("Plugin type")}<select value={typeFilter} onChange={event => setTypeFilter(event.target.value as typeof typeFilter)}><option value="all">{t("All plugin types")}</option><option value="extension">{t("Extension")}</option><option value="server-plugin">{t("Server plugin")}</option></select></label></div>
      <div className="resource-actions plugin-bulk"><label className="check-field"><input type="checkbox" checked={allSelected} disabled={!ready || !visibleManageable.length} onChange={event => { const checked = event.target.checked; setSelected(previous => { const next = new Set(previous); for (const item of visibleManageable) { if (checked) next.add(packageKey(item)); else next.delete(packageKey(item)); } return next; }); }}/>{t("Select visible")}</label><span className="resource-help" role="status">{t("{count} selected", { count: selectedCount })}</span><button className="secondary-btn" disabled={!ready || !selectedCount} onClick={() => stageBulk("upgrade")}>{t("Upgrade selected")}</button><button className="secondary-btn danger-button" disabled={!ready || !selectedCount} onClick={() => stageBulk("remove")}>{t("Remove selected")}</button><button className="secondary-btn" disabled={!ready || !selectedCount} onClick={() => setSelected(new Set())}>{t("Clear selection")}</button></div>
      {!inventory ? <p role="status" className="resource-help">{error ? t("Reload inventory to try reading plugin state again.") : t("Loading plugin inventory…")}</p> : !visible.length ? <p className="resource-help">{inventory.packages.length ? t("No plugins match these filters.") : t("No plugins installed. Install a trusted repository above.")}</p> : <ul className="plugin-list">{visible.map(item => {
        const key = packageKey(item);
        return <li key={key} className="plugin-row"><label className="check-field plugin-identity"><input type="checkbox" checked={selected.has(key)} disabled={!ready || !item.manageable} onChange={event => { const checked = event.target.checked; setSelected(previous => { const next = new Set(previous); if (checked) next.add(key); else next.delete(key); return next; }); }}/><span><strong>{item.name}</strong><small>{kindLabel(item.kind)}{item.version ? ` · ${item.version}` : ""}</small></span></label><div className="plugin-provenance">{item.repository && <span>{item.repository}</span>}{item.commit && <small>{t("Commit")}: {item.commit}</small>}{item.diagnostic && <small className="resource-warning">{item.diagnostic}</small>}{!item.manageable && <small>{t("Read-only")}</small>}</div><div className="plugin-row-actions"><button className="secondary-btn" disabled={!ready || !item.manageable} onClick={() => stageBulk("upgrade", new Set([key]))}>{t("Upgrade")}</button><button className="secondary-btn danger-button" disabled={!ready || !item.manageable} onClick={() => stageBulk("remove", new Set([key]))}>{t("Remove")}</button></div></li>;
      })}</ul>}
    </section>
  </div>;
}
