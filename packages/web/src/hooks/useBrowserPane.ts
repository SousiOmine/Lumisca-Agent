import { useEffect, useRef, useState } from "react";
import { browserPaneApi, type BrowserPaneState } from "../shell.ts";

/** Poll interval while the shell is reachable: the pane opens and closes
 * from the agent's side too (browser_open / browser_close), so a modest
 * interval keeps the UI in sync. */
const POLL_MS = 500;
/** Back-off when the shell is unreachable (plain browser) — the bridge
 * cannot come up later in the same page, so poll rarely. */
const IDLE_POLL_MS = 5_000;

/** The state when no shell (or no lab) exists. */
const CLOSED: BrowserPaneState = { open: false, visible: false, url: null };

/** Live state of the browser lab pane (the right-side panel hosting the
 * agent's debug WebView). Polled from the shell bridge: the pane can be
 * opened/closed by the agent's tools and shown/hidden by the user, so the
 * UI cannot keep a single local flag. In a plain browser (no shell) the
 * state stays closed and every action is a no-op. */
export function useBrowserPane() {
  const [pane, setPane] = useState<BrowserPaneState>(CLOSED);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const state = await browserPaneApi.state();
        if (cancelled) return;
        setPane(state);
        timer.current = setTimeout(poll, POLL_MS);
      } catch {
        if (cancelled) return;
        setPane(CLOSED);
        timer.current = setTimeout(poll, IDLE_POLL_MS);
      }
    };
    timer.current = setTimeout(poll, 0);
    return () => {
      cancelled = true;
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, []);

  const apply = (state: BrowserPaneState): void => setPane(state);

  /** Flip the pane's visibility (the title-bar toggle). */
  const toggle = (): void => {
    browserPaneApi.toggle().then(apply).catch(() => {});
  };

  /** Show or hide the pane. Hiding keeps the lab alive — the agent's
   * browser keeps running in the background. */
  const setVisible = (visible: boolean): void => {
    browserPaneApi.setVisible(visible).then(apply).catch(() => {});
  };

  return { ...pane, toggle, setVisible };
}
