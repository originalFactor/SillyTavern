"use client";

import { Languages } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { isLocale } from "@/lib/i18n-core";

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return <label className="language-switcher"><Languages size={16} aria-hidden="true"/><span className="sr-only">{t("Language")}</span><select aria-label={t("Language")} value={locale} onChange={event => { if (isLocale(event.target.value)) setLocale(event.target.value); }}><option value="en-US" lang="en-US">English</option><option value="zh-CN" lang="zh-CN">简体中文</option></select></label>;
}
