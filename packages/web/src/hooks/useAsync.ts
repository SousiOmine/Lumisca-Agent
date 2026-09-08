import { useEffect } from "preact/compat";

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
