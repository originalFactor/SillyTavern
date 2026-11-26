"use client";

import type { ExtensionPromptSourceRegistrar } from "@/lib/extension-prompts";

import { useI18n } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { createApiClient } from "@/lib/api";
import { encode, enabled, messageOf, pretty, type Capabilities, type Data } from "@/lib/workspace";
import { DocumentEditor, Notice } from "./document-editor";
import { ExtensionUiHost } from "./extension-ui-host";
import type { ExtensionGenerationState } from "@/lib/extension-chat";
import type { ExtensionChatSelection } from "@/lib/extension-runtime/resources";

export function ExtensionsPanel({ capabilities, onDirtyChange, onPrintMessages, onSetSendButtonsEnabled, selection, generationState, onRegisterPromptSource }: { capabilities: Capabilities; onDirtyChange: (dirty: boolean) => void; onPrintMessages?: (signal?: AbortSignal) => Promise<void>; onSetSendButtonsEnabled?: (enabled: boolean, signal: AbortSignal) => void; selection?: ExtensionChatSelection; generationState?: ExtensionGenerationState; onRegisterPromptSource?: ExtensionPromptSourceRegistrar }) {
  const { t } = useI18n();
  const [api] = useState(createApiClient);
  const [extensions, setExtensions] = useState<Data[]>([]), [selected, setSelected] = useState<Data | null>(null), [error, setError] = useState("");
  const [dirty, setDirty] = useState(false), [mode, setMode] = useState<"native" | "json">("native");
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { const controller = new AbortController(); api<Data[]>("/extensions", { signal: controller.signal }).then(setExtensions).catch(e => { if (!controller.signal.aborted) setError(messageOf(e)); }); return () => controller.abort(); }, [api]);
  const discard = () => !dirty || window.confirm(t("Discard the unsaved extension settings draft?"));
  const readOnly = !enabled(capabilities, "resources", "extensionSettings");
  return <div className="settings-page">
    <div className="settings-heading"><div><h1>{t("Extensions")}</h1><p>{t("Extension-owned interfaces and scoped settings. Use Plugin management for installation when enabled by the server operator.")}</p></div></div>
    <Notice error={error}/>
    <div className="preset-layout"><aside className="settings-card">{extensions.map(extension => <button key={extension.id} className="preset-item" aria-pressed={selected?.id === extension.id} onClick={() => { if (selected?.id !== extension.id && discard()) { setDirty(false); setSelected(extension); } }}><span>{extension.displayName}</span><small>{extension.runtime} · {extension.compatibilityStatus} · {extension.enabled ? t("enabled") : t("disabled")}</small></button>)}{!extensions.length && <p className="resource-help">{t("No extensions reported.")}</p>}</aside>
      <div>{selected && <>
        <details className="advanced-json"><summary>{t("Compatibility details")}</summary><pre className="safe-pre resource-help">{pretty({ runtime: selected.runtime, diagnostic: selected.compatibilityDiagnostic, hooks: selected.hooks, capabilities: selected.capabilities })}</pre></details>
        <div className="resource-actions extension-view-switch" role="group" aria-label={t("Settings view")}>{(["native", "json"] as const).map(view => <button key={view} className="secondary-btn" aria-pressed={mode === view} onClick={() => { if (view !== mode && discard()) { setDirty(false); setMode(view); } }}>{t(view === "native" ? "Extension interface" : "Advanced JSON")}</button>)}</div>
        {mode === "native" ? <ExtensionUiHost key={selected.id} extension={selected} readOnly={readOnly} onDirtyChange={setDirty} onPrintMessages={onPrintMessages} onSetSendButtonsEnabled={onSetSendButtonsEnabled} selection={selection} generationState={generationState} onRegisterPromptSource={onRegisterPromptSource}/> : <DocumentEditor key={selected.id} title={selected.displayName} path={`/extensions/${encode(selected.id)}/settings`} keys={["settings"]} method="PATCH" revision={false} readOnly={readOnly} onDirtyChange={setDirty} help={t("Only this extension's settings are merged. This does not authorize extension code or tool execution.")}/>}
      </>}</div>
    </div>
  </div>;
}
