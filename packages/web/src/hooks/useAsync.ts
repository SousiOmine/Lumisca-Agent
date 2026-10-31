import { useEffect, useRef, useState } from "preact/compat";
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
  }, deps);
}

/** What one read of a panel's data looks like while it runs. */
export interface AsyncData<T> {
  /** The last value that read successfully; undefined before the first. */
  data: T | undefined;
  loading: boolean;
  /** The last failure's message, or undefined. A previous `data` is kept: a
   * failed refresh shows the old value with an error, never an empty panel. */
  error: string | undefined;
  /** Re-run the read (a button, or a mutation that invalidated the answer). */
  reload: () => void;
}

/**
 * Read one value for a panel, with the bookkeeping every such panel had
 * written by hand: a loading flag, an error line, a stale guard (a response
 * that lands after the dependencies changed must not overwrite the newer
 * one), and a way to re-read.
 *
 *   const mcp = useAsyncData(() => api.getMcpConfig(), []);
 *   if (mcp.loading && mcp.data === undefined) return <Spinner />;
 *
 * `formatError` defaults to the shared `errorMessage`: the panels that want a
 * translated prefix pass their own.
 */
export function useAsyncData<T>(
  read: (isStale: IsStale) => Promise<T>,
  deps: readonly unknown[],
  formatError: (error: unknown) => string = errorText,
): AsyncData<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  /** Bumped by `reload`: part of the effect's identity, so a re-read is the
   * same code path as the first one (no second implementation to keep in
   * step). */
  const [generation, setGeneration] = useState(0);
  const latestRead = useRef(read);
  useEffect(() => {
    latestRead.current = read;
  });

  useEffect(() => {
    let stale = false;
    const isStale: IsStale = () => stale;
    setLoading(true);
    latestRead.current(isStale).then(
      (value) => {
        if (stale) return;
        setData(value);
        setError(undefined);
        setLoading(false);
      },
      (failure: unknown) => {
        if (stale) return;
        setError(formatError(failure));
        setLoading(false);
      },
    );
    return () => {
      stale = true;
    };
    // Deps are caller-controlled; `generation` is this hook's own reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, generation]);

  return {
    data,
    loading,
    error,
    reload: () => setGeneration((n) => n + 1),
  };
}
