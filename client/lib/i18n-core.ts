import { workspaceMessages } from "./locales/workspace";
import { settingsMessages } from "./locales/settings";
import { conversationMessages } from "./locales/conversation";

export const LOCALES = ["en-US", "zh-CN"] as const;
export type Locale = typeof LOCALES[number];
export type MessageValues = Readonly<Record<string, string | number>>;
export type Translate = (message: string, values?: MessageValues) => string;
export const DEFAULT_LOCALE: Locale = "en-US";
export const LOCALE_STORAGE_KEY = "st-v1-locale";
export const LOCALE_COOKIE = "st-v1-locale";

// Source text is the en-US catalog. One entry defines both languages, avoiding
// missing English keys when a new Chinese translation is added.
export const zhCN: Readonly<Record<string, string>> = { ...workspaceMessages, ...settingsMessages, ...conversationMessages };
export const enUS: Readonly<Record<string, string>> = Object.fromEntries(Object.keys(zhCN).map(key => [key, key]));
export const messages = { "en-US": enUS, "zh-CN": zhCN };
export const isLocale = (value: unknown): value is Locale => value === "en-US" || value === "zh-CN";

/** Negotiate supported language families in preference order, honoring HTTP q. */
export function detectLocale(languages: string | readonly string[] | null | undefined): Locale {
  const preferences = (typeof languages === "string" ? languages.split(",") : languages ?? [])
    .map((entry, index) => {
      const [tag, ...parameters] = entry.trim().split(";");
      const quality = parameters.find(parameter => parameter.trim().startsWith("q="));
      return { tag: tag.toLowerCase(), quality: quality ? Number(quality.trim().slice(2)) : 1, index };
    })
    .filter(entry => Number.isFinite(entry.quality) && entry.quality > 0 && entry.quality <= 1)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { tag } of preferences) {
    if (tag === "zh" || tag.startsWith("zh-")) return "zh-CN";
    if (tag === "en" || tag.startsWith("en-")) return "en-US";
  }
  return DEFAULT_LOCALE;
}

export function translate(locale: Locale, message: string, values: MessageValues = {}): string {
  const catalog = messages[locale];
  const template = Object.hasOwn(catalog, message) ? catalog[message] : message;
  // Replace exactly once: braces in user content must never be re-interpolated.
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, key: string) => Object.hasOwn(values, key) ? String(values[key]) : placeholder);
}
