import { useCallback } from "preact/compat";
import { LANGUAGE_KEY, type Locale } from "@lumisca/core/shared";
import { getLocale, setLocale } from "../i18n.ts";
import { usePreference } from "./usePreference.ts";

/** The selected app language: the UI source of truth while the page is
 * open, persisted to the server setting so it follows the user across
 * reloads, devices and — most importantly — reaches the server, which
 * generates a new session's system prompt from it.
 *
 * A failed persist reverts the choice and reports the error (see
 * usePreference): the stored value is what sessions are created with, so a
 * silent failure would leave the UI and the agent speaking different
 * languages. */
export function useLanguage(): {
  language: Locale;
  setLanguage: (next: Locale) => void;
  error: string | null;
} {
  // The store already holds what the server sent (client.tsx seeds it before
  // the first render), so the preference starts from it rather than from a
  // default: reading it back keeps this hook in step with `setLocale`, which
  // the modules outside the render tree read directly.
  const apply = useCallback((next: Locale) => setLocale(next), []);
  const { value, set, error } = usePreference<Locale>({
    key: LANGUAGE_KEY,
    initial: getLocale(),
    apply,
  });
  return { language: value, setLanguage: set, error };
}
