import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { I18nProvider } from "@/lib/i18n";
import { detectLocale, isLocale, LOCALE_COOKIE } from "@/lib/i18n-core";
import "./globals.css";

export const metadata: Metadata = { title: "SillyTavern · Companion", description: "A focused client for the SillyTavern API v1" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const preference = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(preference) ? preference : detectLocale(requestHeaders.get("accept-language"));
  return <html lang={locale}>
    {/* Browser extensions can add body attributes before hydration (e.g. Grammarly).
        Limit suppression to this element; descendants still report mismatches. */}
    <body suppressHydrationWarning><I18nProvider initialLocale={locale}>{children}</I18nProvider></body>
  </html>;
}
