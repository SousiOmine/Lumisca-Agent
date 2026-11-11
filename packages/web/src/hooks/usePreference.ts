import { errorMessage as errorText } from "@lumisca/core/shared";
import { useCallback, useRef, useState } from "preact/compat";
import { settingsStore } from "../settingsStore.ts";

/**
 * A preference that lives on the server, edited optimistically.
 *
 * `useTheme` and `useLanguage` were the same hook twice: keep the chosen
 * value in state, apply it everywhere immediately, write it through the
 * settings store, and — if the write fails — roll back to what the server
 * still holds. The rollback rule is the subtle part and both copies stated it
 * identically:
 *
 *   a failed request must not revert a choice the user made while it was in
 *   flight.
 *
 * Reading the state from the callback's closure would do exactly that (the
 * closure holds the value from the render that created it); a ref that tracks
 * the LATEST attempt is what makes the comparison honest. That rule is here
 * now, once.
 *
 * `apply` runs for both the optimistic value and a rollback, so a preference
 * with a side effect outside React (the document's theme attribute, the
 * module-level locale store) keeps it in one place.
 */
export interface Preference<T> {
  /** The value in effect. */
  value: T;
  /** Choose a new value: applied now, persisted in the background. */
  set(next: T): void;
  /** The last failed save, or null. */
  error: string | null;
}

export function usePreference<T extends string>(options: {
  /** The settings key the server stores it under. */
  key: string;
  /** The value to start with (from the server's bootstrap data). */
  initial: T;
  /** Apply the value outside React (a DOM attribute, a module store). Called
   * for the optimistic choice and for a rollback, never for a failed one. */
  apply?: (value: T) => void;
}): Preference<T> {
  const { key, initial, apply } = options;
  const [value, setValue] = useState<T>(initial);
  const [error, setError] = useState<string | null>(null);
  /** The value the last persist attempt wrote — see the module comment. */
  const chosen = useRef(value);

  const set = useCallback(
    (next: T) => {
      const previous = chosen.current;
      if (previous === next) return;
      chosen.current = next;
      setError(null);
      // Optimistic: the value applies immediately; a failed persist rolls back
      // to the one the server still holds.
      setValue(next);
      apply?.(next);
      // Through the settings store, not `api.setSetting` directly: the store is
      // what every other screen reads, so a value picked here must land there
      // too (a panel open beside this one would otherwise keep the old value).
      settingsStore.set(key, next).catch((failure) => {
        setError(errorText(failure));
        if (chosen.current !== next) return; // a newer choice superseded this
        chosen.current = previous;
        setValue(previous);
        apply?.(previous);
      });
    },
    [key, apply],
  );

  return { value, set, error };
}
