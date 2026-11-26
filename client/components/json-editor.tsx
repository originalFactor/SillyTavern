"use client";

import { useI18n } from "@/lib/i18n";

import { useId, useMemo, useState } from "react";
import styles from "./json-editor.module.css";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Kind = "string" | "number" | "boolean" | "object" | "array" | "null";
const defaults: Record<Kind, Json> = { string: "", number: 0, boolean: false, object: {}, array: [], null: null };
const PAGE_SIZE = 30;
const kindOf = (value: Json): Kind => value === null ? "null" : Array.isArray(value) ? "array" : typeof value as Kind;
const titleOf = (key: string) => key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, letter => letter.toUpperCase());

function NumberField({ value, change, disabled, label }: { value: number; change: (value: Json) => void; disabled: boolean; label: string }) {
  const [draft, setDraft] = useState(String(value));
  const [previous, setPrevious] = useState(value);
  if (previous !== value) { setPrevious(value); setDraft(String(value)); }
  return <input aria-label={label} type="number" step="any" disabled={disabled} value={draft} onChange={event => {
    setDraft(event.target.value);
    if (event.target.value !== "" && Number.isFinite(event.target.valueAsNumber)) change(event.target.valueAsNumber);
  }} onBlur={() => setDraft(String(value))}/>;
}

function ValueField({ value, change, disabled, label, depth }: { value: Json; change: (value: Json) => void; disabled: boolean; label: string; depth: number }) {
  const { t } = useI18n();
  if (typeof value === "boolean") return <label className={styles.toggle}><input aria-label={label} type="checkbox" checked={value} disabled={disabled} onChange={event => change(event.target.checked)}/>{value ? t("Enabled") : t("Disabled")}</label>;
  if (typeof value === "number") return <NumberField value={value} change={change} disabled={disabled} label={label}/>;
  if (typeof value === "string") return <textarea aria-label={label} rows={value.includes("\n") || value.length > 100 ? 4 : 1} value={value} disabled={disabled} spellCheck={false} onChange={event => change(event.target.value)}/>;
  if (value === null) return <span className={styles.empty}>{t("No value (null)")}</span>;
  if (depth >= 12) return <p className={styles.empty}>{t("Deeply nested value preserved. Use JSON to edit beyond 12 levels.")}</p>;
  return <Collection value={value} change={change} disabled={disabled} depth={depth}/>;
}

function Collection({ value, change, disabled, depth }: { value: Json[] | { [key: string]: Json }; change: (value: Json) => void; disabled: boolean; depth: number }) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(PAGE_SIZE), [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false), [name, setName] = useState(""), [type, setType] = useState<Kind>("string");
  const array = Array.isArray(value);
  const entries = Object.entries(value);
  const filtered = entries.filter(([key]) => titleOf(key).toLowerCase().includes(filter.toLowerCase()) || key.toLowerCase().includes(filter.toLowerCase()));
  const update = (key: string, next: Json) => change(array ? value.map((item, index) => String(index) === key ? next : item) : { ...value, [key]: next });
  const remove = (key: string) => {
    if (!window.confirm(t("Remove {item} from this draft?", { item: array ? t("item {number}", { number: Number(key) + 1 }) : t("field “{key}”", { key }) }))) return;
    if (array) change(value.filter((_, index) => String(index) !== key));
    else change(Object.fromEntries(entries.filter(([entry]) => entry !== key)));
  };
  return <div className={styles.collection}>
    {entries.length > PAGE_SIZE && <input className={styles.search} aria-label={t("Filter field names")} placeholder={t("Filter field names…")} value={filter} onChange={event => { setFilter(event.target.value); setVisible(PAGE_SIZE); }}/>}
    {filtered.slice(0, visible).map(([key, item]) => {
      const label = array ? t("Item {number}", { number: Number(key) + 1 }) : titleOf(key);
      const nested = item !== null && typeof item === "object";
      const controls = <div className={styles.rowActions}><select className={styles.typePicker} aria-label={t("Value type for {label}", { label })} disabled={disabled} value={kindOf(item)} onChange={event => { const kind = event.target.value as Kind; if (window.confirm(t("Replace {label} with an empty {kind} value? Its current value will be removed from this draft.", { label, kind }))) update(key, defaults[kind]); }}>{Object.keys(defaults).map(kind => <option key={kind} value={kind}>{kind}</option>)}</select>{array && <><button type="button" disabled={disabled || Number(key) === 0} aria-label={t("Move {label} up", { label })} onClick={() => { const next = [...value]; [next[Number(key) - 1], next[Number(key)]] = [next[Number(key)], next[Number(key) - 1]]; change(next); }}>↑</button><button type="button" disabled={disabled || Number(key) === value.length - 1} aria-label={t("Move {label} down", { label })} onClick={() => { const next = [...value]; [next[Number(key) + 1], next[Number(key)]] = [next[Number(key)], next[Number(key) + 1]]; change(next); }}>↓</button></>}<button type="button" disabled={disabled} aria-label={t("Remove {label}", { label })} onClick={() => remove(key)}>{t("Remove")}</button></div>;
      return <div className={styles.row} key={key}>{nested ? <details><summary><span>{label}<small>{array ? "" : key}</small></span><span className={styles.badge}>{Object.keys(item).length} {Array.isArray(item) ? t("items") : t("fields")}</span></summary><div className={styles.nested}><ValueField value={item} change={next => update(key, next)} disabled={disabled} label={label} depth={depth + 1}/>{controls}</div></details> : <><div className={styles.fieldLabel}><span>{label}</span><code>{array ? kindOf(item) : key}</code></div><ValueField value={item} change={next => update(key, next)} disabled={disabled} label={label} depth={depth + 1}/>{controls}</>}</div>;
    })}
    {!filtered.length && <p className={styles.empty}>{entries.length ? t("No matching field names.") : array ? t("No items yet. Add an item below.") : t("No fields yet. Add a field below.")}</p>}
    {filtered.length > visible && <button type="button" className={styles.more} onClick={() => setVisible(count => count + PAGE_SIZE)}>{t("Show next {count} of {remaining} remaining", { count: Math.min(PAGE_SIZE, filtered.length - visible), remaining: filtered.length - visible })}</button>}
    {!disabled && <div className={styles.add}>{adding ? <><div className={styles.addInputs}>{!array && <label>{t("Field name")}<input autoFocus aria-label={t("New field name")} value={name} onChange={event => setName(event.target.value)} placeholder={t("e.g. temperature")}/></label>}<label>{t("Value type")}<select value={type} onChange={event => setType(event.target.value as Kind)}>{Object.keys(defaults).map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label></div>{!array && Object.hasOwn(value, name) && <p role="alert" className={styles.invalid}>{t("That field already exists. Edit it above instead.")}</p>}<div className={styles.addActions}><button type="button" disabled={!array && (!name.trim() || Object.hasOwn(value, name))} onClick={() => { change(array ? [...value, defaults[type]] : { ...value, [name]: defaults[type] }); setName(""); setAdding(false); setFilter(""); setVisible(entries.length + 1); }}>{t("Add")} {array ? t("item") : t("field")}</button><button type="button" onClick={() => setAdding(false)}>{t("Cancel")}</button></div></> : <button type="button" onClick={() => setAdding(true)}>{t("+ Add")} {array ? t("item") : t("field")}</button>}</div>}
  </div>;
}

/** Both views edit the same draft. No schema normalization or implicit save. */
export function JsonEditor({ text, onChange, disabled = false, label = "Configuration", validate }: { text: string; onChange: (text: string) => void; disabled?: boolean; label?: string; validate?: (text: string) => unknown }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"fields" | "json">("fields");
  const id = useId();
  const parsed = useMemo(() => {
    try {
      const value = (validate ? validate(text) : JSON.parse(text)) as Json;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The draft must be a JSON object.");
      return { value, error: "" };
    } catch (error) { return { value: null, error: error instanceof Error ? error.message : "Invalid JSON." }; }
  }, [text, validate]);
  const showJson = mode === "json" || parsed.value === null;
  return <div className={styles.editor} aria-label={t(label)}>
    <div className={styles.toolbar}><div className={styles.modes} role="group" aria-label={t("{label} editor view", { label: t(label) })}><button type="button" aria-pressed={!showJson} disabled={!parsed.value} onClick={() => setMode("fields")}>{t("Fields")}</button><button type="button" aria-pressed={showJson} onClick={() => setMode("json")}>JSON</button></div><span>{t("Draft only · Save to apply")}</span></div>
    {parsed.error && <p role="alert" id={`${id}-error`} className={styles.invalid}>{t(parsed.error)} {t("Fix the JSON to return to the field editor.")}</p>}
    {showJson ? <><label className={styles.rawLabel} htmlFor={id}>{t(label)} JSON</label><textarea id={id} className={styles.raw} aria-invalid={Boolean(parsed.error)} aria-describedby={parsed.error ? `${id}-error` : undefined} disabled={disabled} spellCheck={false} autoCapitalize="off" autoCorrect="off" value={text} onChange={event => onChange(event.target.value)}/></> : parsed.value && <Collection value={parsed.value} change={next => onChange(JSON.stringify(next, null, 2))} disabled={disabled} depth={0}/>}
    <p className={styles.note}>{t("All fields are preserved. Use Fields for individual values or JSON for bulk edits. Field types follow the loaded document; new fields need an explicit value type.")}</p>
  </div>;
}
