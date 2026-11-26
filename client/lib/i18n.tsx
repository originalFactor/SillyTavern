"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isLocale, LOCALE_COOKIE, LOCALE_STORAGE_KEY, translate, type Locale, type Translate } from "./i18n-core";

type I18nContextValue = { locale: Locale; setLocale: (locale: Locale) => void; t: Translate };
const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale: Locale }) {
  const [locale, updateLocale] = useState(initialLocale);
  useEffect(() => {
    // Storage may be unavailable in private/embedded browser environments.
    try { const stored = localStorage.getItem(LOCALE_STORAGE_KEY); if (isLocale(stored)) updateLocale(stored); } catch { /* Keep the server-negotiated language. */ }
  }, []);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const setLocale = useCallback((next: Locale) => {
    if (!isLocale(next)) return;
    updateLocale(next);
    try { localStorage.setItem(LOCALE_STORAGE_KEY, next); } catch { /* Switching still works in memory. */ }
    try { document.cookie = `${LOCALE_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`; } catch { /* Storage is optional. */ }
  }, []);
  const t = useCallback<Translate>((message, values) => translate(locale, message, values), [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used within I18nProvider");
  return value;
}
