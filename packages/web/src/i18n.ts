/**
 * The UI language: one module store plus the hooks components use.
 *
 * The value itself lives on the server (a setting — see settings-keys.ts)
 * and reaches the page through `InitialData`; this module only mirrors it
 * for rendering. The store shape follows the other shared stores
 * (modelCatalog.ts, providers.ts): a module-level value with subscribers, so
 * every component that renders text re-renders when the language changes,
 * without prop drilling through the whole tree.
 *
 * Language changes are applied optimistically by useLanguage (a failed save
 * rolls back), so the store must be written only through it or setLocale.
 */
import { useMemo, useSyncExternalStore } from "preact/compat";
import {
  createTranslator,
  DEFAULT_LOCALE,
  type Locale,
  type MessageKey,
  type MessageParams,
  translate,
  type Translator,
} from "@lumisca/core/shared";

let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

/** The language the UI renders in right now. */
export function getLocale(): Locale {
  return current;
}

/** Seed the store from the server's bootstrap data, before the first
 * render (client.tsx). No notification: nothing is mounted yet. */
export function initLocale(locale: Locale): void {
  current = locale;
  applyDocumentLanguage();
}

/** Switch the language and re-render every consumer. */
export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  applyDocumentLanguage();
  for (const listener of [...listeners]) listener();
}

/** Subscribe to language changes (useLocale's subscription). */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current language, re-rendering the component when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale);
}

/** The message lookup for the current language. Components must call this
 * (a plain `t` call would not re-render on a language change). */
export function useT(): Translator {
  const locale = useLocale();
  return useMemo(() => createTranslator(locale), [locale]);
}

/** Message lookup outside the render tree (notification text, module-level
 * helpers). Components use {@link useT}. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(current, key, params);
}

/** Keep the document's language in sync: the stylesheet and assistive
 * technology use it (font fallback, hyphenation, screen-reader voice). */
function applyDocumentLanguage(): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = current;
}
