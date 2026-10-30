import { useEffect, useRef } from "preact/compat";

/**
 * Run `tick` on a fixed cadence, but never while the page is hidden.
 *
 * The app polls several things on their own clocks (the shell's window
 * state, the server's health, the update status, stella's machine state, the
 * routines list, the event-stream revision probe). Each of them used to run
 * its timer unconditionally, so a background tab kept waking the CPU and —
 * on a laptop — the network for as long as the app stayed open. A hidden
 * page's work is wasted work: nothing it computes is visible, and a
 * suspended tab's timers are throttled by the browser anyway, so the ticks
 * it does get are late ones.
 *
 * `immediate` runs the first tick right away (most pollers want the state
 * before the first interval elapses); `false` waits one interval.
 *
 * The callback is held in a ref, so a caller whose closure changes every
 * render does not restart the timer.
 */
/** Pass as `ms` to disable the loop without changing the hook's call site
 * (a timer longer than a browser session). */
export const NEVER = 1e9;

export function useVisibleInterval(
  tick: () => void,
  ms: number,
  options: { immediate?: boolean } = {},
): void {
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const schedule = (delay: number) => {
      if (stopped) return;
      timer = setTimeout(run, delay);
    };
    const run = () => {
      if (stopped) return;
      if (document.hidden) {
        // Hidden: keep the chain alive but idle until the page returns.
        schedule(ms);
        return;
      }
      tickRef.current();
      // A tick that took longer than the interval must not queue a burst.
      schedule(ms);
    };

    // Coming back to the page reads the state at once instead of after the
    // next interval (which may be as long as a minute).
    const onVisibility = () => {
      if (document.hidden) return;
      if (timer !== undefined) clearTimeout(timer);
      schedule(0);
    };

    document.addEventListener("visibilitychange", onVisibility);
    schedule(options.immediate === false ? ms : 0);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ms, options.immediate]);
}
