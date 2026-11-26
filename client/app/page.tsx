"use client";

import { useI18n } from "@/lib/i18n";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, connectionBase, readConnection, setSessionToken, type Character } from "@/lib/api";
import { DOCUMENTS, enabled, messageOf, pretty, type Capabilities, type Data, type Target } from "@/lib/workspace";
import { ApiSettings } from "@/components/api-settings";
import { PresetSettings } from "@/components/preset-settings";
import { ResourceLibrary, type LibraryKind } from "@/components/resource-library";
import { DocumentEditor } from "@/components/document-editor";
import { Conversation } from "@/components/conversation";
import { ExtensionsPanel } from "@/components/extensions-panel";
import { PluginManagement } from "@/components/plugin-management";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ArrowUpRight, BookOpen, Braces, ChevronRight, Home as HomeIcon, Library, Menu, MessageSquare, Puzzle, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Terminal, UserRound, Users, X, type LucideIcon } from "lucide-react";

type View = "home" | "chat" | "settings" | "presets" | "extensions" | "package-management" | "capabilities" | LibraryKind | keyof typeof DOCUMENTS;
const NAV: { id: View; label: string; capability: string; icon: LucideIcon }[] = [
  { id: "characters", label: "Character cards", capability: "characters", icon: Library },
  { id: "personas", label: "Personas", capability: "personas", icon: UserRound },
  { id: "groups", label: "Groups", capability: "groups", icon: Users },
  { id: "presets", label: "Presets", capability: "presets", icon: SlidersHorizontal },
  { id: "prompts", label: "Prompt Manager", capability: "promptManager", icon: Terminal },
  { id: "world-info", label: "World Info books", capability: "worldInfoManagement", icon: BookOpen },
  { id: "worldSettings", label: "World Info settings", capability: "worldInfoManagement", icon: Settings2 },
  { id: "variables", label: "Global variables", capability: "macroManagement", icon: Braces },
  { id: "regex", label: "Regex scripts", capability: "regexManagement", icon: Search },
  { id: "extensions", label: "Extensions", capability: "extensions", icon: Puzzle },
  { id: "package-management", label: "Plugin management", capability: "packageManagement", icon: Puzzle },
  { id: "settings", label: "API settings", capability: "settingsRead", icon: Settings2 },
];

export default function Home() {
  const { t } = useI18n();
  const [connected, setConnected] = useState(false), [connecting, setConnecting] = useState(false), [openConnect, setOpenConnect] = useState(false);
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8000"), [token, setToken] = useState("");
  const [capabilities, setCapabilities] = useState<Capabilities>({}), [session, setSession] = useState<Data>({});
  const [characters, setCharacters] = useState<Character[]>([]), [target, setTarget] = useState<Target | null>(null);
  const [view, setView] = useState<View>("home"), [dirty, setDirty] = useState(false), [connectionId, setConnectionId] = useState(0);
  const [mobileNav, setMobileNav] = useState(false), [filter, setFilter] = useState(""), [error, setError] = useState("");
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!mobileNav) return;
    const trigger = menuButton.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sidebar.current?.querySelector<HTMLButtonElement>(".mobile-nav-close")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMobileNav(false); menuButton.current?.focus(); }
      if (event.key === "Tab") {
        const controls = sidebar.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
        if (!controls?.length) return;
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    const onResize = () => { if (window.innerWidth > 620) setMobileNav(false); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", onKeyDown); window.removeEventListener("resize", onResize); trigger?.focus(); };
  }, [mobileNav]);
  const leave = () => !dirty || window.confirm(t("Discard the unsaved draft before leaving this page?"));
  const changeView = (next: View) => { if (next !== view && !leave()) return; setView(next); setMobileNav(false); };
  const loadCharacters = useCallback(async () => { setCharacters(await api<Character[]>("/characters")); }, []);
  const refreshCharacters = useCallback(() => { void loadCharacters().catch(e => setError(messageOf(e))); }, [loadCharacters]);
  const openChats = (next: Target) => { if (!leave()) return; setTarget(next); setView("chat"); setMobileNav(false); };

  const connect = async (url = baseUrl, bearer = token) => {
    if (!leave()) return;
    setConnecting(true); setError("");
    // Unmount resource editors before changing their authenticated server.
    setConnected(false); setView("home"); setTarget(null); setCapabilities({});
    try {
      const base = connectionBase(url); localStorage.setItem("st-v1-base-url", base); setSessionToken(bearer.trim());
      if (bearer.trim()) await api("/companion/health");
      const next = await api<Capabilities>("/capabilities");
      if (next.auth?.csrf) throw new Error("This client requires a bearer companion or host-managed session without a legacy CSRF bootstrap.");
      const context = enabled(next, "resources", "session") ? await api<Data>("/session") : {};
      const cards = enabled(next, "resources", "characters") ? await api<Character[]>("/characters") : [];
      setBaseUrl(base); setToken(""); setCapabilities(next); setSession(context); setCharacters(cards); setConnectionId(previous => previous + 1); setConnected(true); setOpenConnect(false); setDirty(false);
    } catch (e) { localStorage.removeItem("st-v1-base-url"); setSessionToken(""); setOpenConnect(true); setError(messageOf(e)); }
    finally { setConnecting(false); }
  };

  useEffect(() => {
    const restore = async () => {
      try {
        const response = await fetch("/api/v1/client-connection", { cache: "no-store", redirect: "error" });
        if (response.ok) { const managed = await response.json() as { baseUrl: string; token: string }; await connect(managed.baseUrl, managed.token); return; }
      } catch { /* Manual bearer connection remains available without a managed host. */ }
      const connection = readConnection();
      if (connection) await connect(connection.baseUrl, connection.token); else setOpenConnect(true);
    };
    void restore();
    // Bootstrap once; tokens live only in memory and are never persisted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleCharacters = useMemo(() => characters.filter(character => character.name.toLowerCase().includes(filter.toLowerCase())), [characters, filter]);
  const documentConfig = Object.hasOwn(DOCUMENTS, view) ? DOCUMENTS[view as keyof typeof DOCUMENTS] : null;
  const library = ["characters", "personas", "world-info", "groups"].includes(view) ? view as LibraryKind : null;
  const navigationLabel = NAV.find(item => item.id === view)?.label;
  const label = navigationLabel ? t(navigationLabel) : view === "chat" ? target?.name : t("Overview");
  const content = !connected ? <div className="welcome-wrap"><div className="welcome"><div className="eyebrow"><span className="dot"/>{t("No server connected")}</div><h1>{t("Your conversation workspace.")}</h1><p>{t("Connect to your SillyTavern server to open character chats, shape prompts, and manage your library in one place.")}</p><button className="primary-btn" onClick={() => setOpenConnect(true)}>{t("Connect to server")}<ArrowUpRight size={16}/></button></div><div className="welcome-cards"><div className="welcome-card"><MessageSquare size={20}/><div><strong>{t("Pick up a conversation")}</strong><p>{t("Your characters and chat history load from your server.")}</p></div></div><div className="welcome-card"><ShieldCheck size={20}/><div><strong>{t("Keep credentials on your server")}</strong><p>{t("This workspace uses API v1. Provider keys stay write-only.")}</p></div></div></div></div> :
    library ? <ResourceLibrary key={`${connectionId}:${library}`} kind={library} capabilities={capabilities} onDirtyChange={setDirty} onChanged={refreshCharacters} onOpenChats={openChats}/> :
    documentConfig ? <div className="settings-page"><div className="settings-heading"><div><div className="heading-kicker">{t("ACTIVE CONFIGURATION")}</div><h1>{t(documentConfig.title)}</h1></div></div><DocumentEditor key={`${connectionId}:${view}`} {...documentConfig} title={t(documentConfig.title)} help={t(documentConfig.help)} prompts={view === "prompts"} regex={view === "regex"} onDirtyChange={setDirty}/></div> :
    view === "presets" ? <PresetSettings key={connectionId} onDirtyChange={setDirty}/> :
    view === "settings" ? <ApiSettings key={connectionId} capabilities={capabilities} onDirtyChange={setDirty}/> :
    view === "extensions" ? <ExtensionsPanel key={connectionId} capabilities={capabilities} onDirtyChange={setDirty}/> :
    view === "package-management" ? <PluginManagement key={connectionId} onDirtyChange={setDirty}/> :
    view === "chat" && target ? <Conversation key={`${connectionId}:${target.kind}:${target.id}`} target={target} capabilities={capabilities} handle={String(session.handle ?? "session")} onDirtyChange={setDirty}/> :
    view === "capabilities" ? <div className="settings-page"><h1>{t("Server capabilities")}</h1><p className="resource-help">{t("Controls are shown only for explicitly advertised resources. Partial group, regex and prompt support does not imply complete upstream parity.")}</p><pre className="safe-pre">{pretty(capabilities)}</pre></div> :
    <div className="welcome-wrap"><div className="welcome"><div className="eyebrow"><span className="dot online"/>{t("Workspace ready")}</div><h1>{t("Make room for your next conversation.")}</h1><p>{t("Open a character from the sidebar to continue a chat. Manage the characters, context, and connection behind each conversation here.")}</p>{enabled(capabilities, "resources", "characters") && <button className="primary-btn" onClick={() => changeView("characters")}><Library size={16}/>{t("Browse characters")}</button>}</div><div className="welcome-cards">{[
      { id: "characters" as View, capability: "characters", icon: MessageSquare, title: "Characters & conversations", copy: "Manage cards and open their saved chats." },
      { id: "prompts" as View, capability: "promptManager", icon: Terminal, title: "Shape the context", copy: "Review and edit the prompts sent with your chats." },
      { id: "settings" as View, capability: "settingsRead", icon: Settings2, title: "Configure your connection", copy: "Manage the model, provider, and server-held key." },
    ].filter(item => enabled(capabilities, "resources", item.capability)).map(item => <button className="welcome-card" key={item.id} onClick={() => changeView(item.id)}><item.icon size={20}/><div><strong>{t(item.title)}</strong><p>{t(item.copy)}</p></div><ChevronRight size={16}/></button>)}<div className="welcome-note"><ShieldCheck size={15}/>{t("Only features advertised by your server are shown.")}</div></div></div>;

  return <main className="shell"><a className="skip-link" href="#workspace-content">{t("Skip to workspace")}</a>{mobileNav && <button className="nav-backdrop" tabIndex={-1} aria-label={t("Dismiss navigation")} onClick={() => { setMobileNav(false); menuButton.current?.focus(); }}/>}<aside ref={sidebar} id="workspace-navigation" className={`sidebar workspace-sidebar ${mobileNav ? "mobile-open" : ""}`} aria-label={t("Workspace navigation")}>
    <div className="brand"><div className="brand-mark"><MessageSquare size={17}/></div><span>SillyTavern</span><span className="brand-tag">{t("Workspace")}</span><button className="icon-btn mobile-nav-close" aria-label={t("Close navigation")} onClick={() => { setMobileNav(false); menuButton.current?.focus(); }}><X size={18}/></button></div>
    <nav className="side-actions workspace-nav" aria-label={t("Workspace")}><button className={`quiet-action ${view === "home" ? "nav-active" : ""}`} aria-current={view === "home" ? "page" : undefined} onClick={() => changeView("home")}><HomeIcon size={17}/>{t("Overview")}</button>{connected && NAV.filter(item => enabled(capabilities, "resources", item.capability)).map(item => <button key={item.id} className={`quiet-action ${view === item.id ? "nav-active" : ""}`} aria-current={view === item.id ? "page" : undefined} onClick={() => changeView(item.id)}><item.icon size={17}/>{t(item.label)}</button>)}</nav>
    <div className="side-label-row"><span>{t("Character chats")}</span>{connected && enabled(capabilities, "resources", "characters") && <button className="icon-btn" aria-label={t("Refresh characters")} onClick={refreshCharacters}><RefreshCw size={15}/></button>}</div><div className="search"><Search size={15}/><input aria-label={t("Find a character")} placeholder={t("Find a character…")} value={filter} onChange={event => setFilter(event.target.value)}/></div>
    <div className="character-list">{visibleCharacters.length === 0 && <p className="empty-side">{!connected ? t("Connect a server to load your characters.") : filter ? t("No matching characters. Try another name.") : t("No characters yet. Add one in Character cards when available.")}</p>}{visibleCharacters.map(character => <button key={character.id} className={`character-row ${view === "chat" && target?.kind === "character" && target.id === character.id ? "selected" : ""}`} onClick={() => openChats({ kind: "character", id: character.id, name: character.name })}><div className="avatar">{character.name.slice(0, 1).toUpperCase()}</div><span className="character-name">{character.name}</span><span className="row-count">{character.chatCount}</span></button>)}</div>
    <div className="sidebar-bottom"><div className="connection"><span className={`dot ${connected ? "online" : ""}`}/><span>{connected ? String(session.userName ?? t("API connected")) : t("Not connected")}</span><button className="icon-btn" aria-label={t("Connect to server")} onClick={() => { setMobileNav(false); setOpenConnect(true); }}><Settings2 size={15}/></button></div>{connected && <button className="quiet-action" onClick={() => changeView("capabilities")}><ShieldCheck size={14}/>{t("Server capabilities")}</button>}</div>
  </aside><section className="main-area" inert={mobileNav}><header className="topbar"><div className="breadcrumbs"><button ref={menuButton} className="icon-btn mobile-menu" aria-label={t("Open navigation")} aria-controls="workspace-navigation" aria-expanded={mobileNav} onClick={() => setMobileNav(true)}><Menu size={18}/></button><span className="crumb-muted">{t("Workspace")}</span><span className="crumb-slash">/</span><span>{label}</span></div><div className="top-actions"><LanguageSwitcher/><div className="status-pill"><span className={`dot ${connected ? "online" : ""}`}/>{connected ? t("Connected") : t("Offline")}</div><button className="icon-btn" aria-label={t("API connection")} onClick={() => setOpenConnect(true)}><Settings2 size={17}/></button></div></header><div id="workspace-content" className="workspace-content" tabIndex={-1}>{content}</div>{error && !openConnect && <div role="alert" className="toast-error"><span>{t(error)}</span><button className="icon-btn" aria-label={t("Dismiss error")} onClick={() => setError("")}><X size={15}/></button></div>}</section>
    {openConnect && <div className="modal-backdrop"><section className="connect-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title"><button className="modal-close icon-btn" aria-label={t("Close connection dialog")} disabled={connecting} onClick={() => setOpenConnect(false)}><X size={17}/></button><div className="modal-brand" id="connect-title"><ShieldCheck size={20}/>{t("Connect to SillyTavern")}</div><div className="connect-language"><LanguageSwitcher/></div><p className="modal-copy">{t("All backend operations use /api/v1. The bearer capability remains in memory. Companion connections must use the host’s loopback origin.")}</p><label>{t("Server origin")}<input value={baseUrl} disabled={connecting} onChange={event => setBaseUrl(event.target.value)} autoComplete="url" placeholder="http://127.0.0.1:8000"/></label><label>{t("Bearer capability")}<input type="password" value={token} disabled={connecting} onChange={event => setToken(event.target.value)} autoComplete="off"/></label>{error && <p role="alert" className="modal-error">{t(error)}</p>}<button className="primary-btn connect-submit" disabled={connecting} onClick={() => void connect()}>{connecting ? t("Connecting…") : t("Verify & connect")}</button></section></div>}
  </main>;
}
