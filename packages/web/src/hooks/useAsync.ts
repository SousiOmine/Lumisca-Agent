import { useCallback, useEffect, useState } from "react";
import type { DependencyList } from "react";
import { errorMessage as errorText } from "@lumisca/core/shared";

/** Stale probe passed to async effects: true once the effect was cleaned
 * up (unmount or deps change), so late responses never write state. */
export type IsStale = () => boolean;

/** Run an async effect with unmount/stale protection. The effect receives
 * `isStale`; check it after every await before writing state. Replaces the
 * `let stale = false ... return () => { stale = true; }` boilerplate
 * repeated across settings panels and views. Polling loops with their own
 * timers (title bar, pane, update status, login poll) intentionally keep
 * their local `cancelled` flag — their timer bookkeeping does not fit a
 * one-shot effect.
 *
 *   useAsyncEffect(async (isStale) => {
 *     const settings = await api.getSettings();
 *     if (isStale()) return;
 *     setValues(settings);
 *   }, []);
 */
export function useAsyncEffect(
  effect: (isStale: IsStale) => void | Promise<void>,
  deps: readonly unknown[],
): void {
  useEffect(() => {
    let stale = false;
    const isStale: IsStale = () => stale;
    void effect(isStale);
    return () => {
      stale = true;
    };
    // Deps are caller-controlled, mirroring useEffect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps as DependencyList);
}

/** One-shot async data load with stale protection, loading/error state,
 * and reload. For the simple "fetch once on mount, show error" panels so
 * the loading/error bookkeeping never varies. */
export function useAsyncData<T>(
  load: (isStale: IsStale) => Promise<T>,
  deps: readonly unknown[],
  initial: T,
): {
  data: T;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T>(initial);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [seq, setSeq] = useState(0);

  useAsyncEffect(async (isStale) => {
    setLoading(true);
    setError(undefined);
    try {
      const value = await load(isStale);
      if (isStale()) return;
      setData(value);
    } catch (e) {
      if (!isStale()) setError(errorText(e));
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [...deps, seq]);

  const reload = useCallback(() => setSeq((s) => s + 1), []);
  return { data, error, loading, reload };
}

/** Build a `.catch()` handler that stores the message via `setError`
 * unless the effect is stale. For promise chains inside `useAsyncEffect`
 * where try/catch would indent the whole chain:
 *
 *   api.getSettings().then(setValues).catch(catchTo(setError, isStale));
 */
export function catchTo(
  setError: (message: string | undefined) => void,
  isStale?: IsStale,
): (e: unknown) => void {
  return (e: unknown) => {
    if (isStale?.() ?? false) return;
    setError(errorText(e));
  };
}
