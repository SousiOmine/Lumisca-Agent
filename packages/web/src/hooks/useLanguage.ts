import { useCallback, useRef, useState } from "preact/compat";
import {
  errorMessage as errorText,
  LANGUAGE_KEY,
  type Locale,
} from "@lumisca/core/shared";
import { getLocale, setLocale } from "../i18n.ts";
import { settingsStore } from "../settingsStore.ts";

/** The selected app language: the UI source of truth while the page is
 * open, persisted to the server setting so it follows the user across
 * reloads, devices and — most importantly — reaches the server, which
 * generates a new session's system prompt from it.
 *
 * A failed persist reverts the choice and reports the error, exactly like
 * useTheme: the stored value is what sessions are created with, so a silent
 * failure would leave the UI and the agent speaking different languages. */
export function useLanguage(): {
  language: Locale;
  setLanguage: (next: Locale) => void;
  error: string | null;
} {
  // The store already holds what the server sent (client.tsx seeds it
  // before the first render); reading it back keeps this hook in step with
  // `setLocale`, which the modules outside the render tree read directly.
  const [language, setLanguageState] = useState<Locale>(getLocale);
  const [error, setError] = useState<string | null>(null);
  // The language the last persist attempt wrote: a failed request must roll
  // back to what the server still holds, but only while the user has not
  // picked something newer in the meantime.
  const chosen = useRef(language);

  const setLanguage = useCallback((next: Locale) => {
    const previous = chosen.current;
    if (previous === next) return;
    chosen.current = next;
    setError(null);
    // Optimistic: the UI switches immediately and rolls back if the save
    // fails.
    setLanguageState(next);
    setLocale(next);
    // Through the settings store for the same reason useTheme uses it: the
    // generic settings surface lists this key, and a value written around the
    // store would leave that list showing the previous language.
    settingsStore.set(LANGUAGE_KEY, next).catch((failure) => {
      setError(errorText(failure));
      if (chosen.current !== next) return; // a newer choice superseded this one
      chosen.current = previous;
      setLanguageState(previous);
      setLocale(previous);
    });
  }, []);

  return { language, setLanguage, error };
}
