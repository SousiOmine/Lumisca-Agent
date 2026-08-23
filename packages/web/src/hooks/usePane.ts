import { useEffect, useRef, useState } from "react";
import { paneApi, type PaneState } from "../shell.ts";

/** Poll interval while the shell is reachable: the pane opens and closes
 * from the agent's side too, so a modest interval keeps the UI in sync. */
const POLL_MS = 500;
/** Back-off when the shell is unreachable (plain browser) — the bridge
 * cannot come up later in the same page, so poll rarely. */
const IDLE_POLL_MS = 5_000;

/** The state when no shell exists. */
const CLOSED: PaneState = { open: false, visible: false, content: null };

/** Live state of the docked pane (the right-side panel hosting a native
 * surface such as the agent's browser WebView). Polled from the shell
 * bridge: the pane can be opened/closed by the agent's tools and
 * shown/hidden by the user, so the UI cannot keep a single local flag.
 * In a plain browser (no shell) the state stays closed and every action
 * is a no-op. */
export function usePane() {
  const [pane, setPane] = useState<PaneState>(CLOSED);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const state = await paneApi.state();
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

  const apply = (state: PaneState): void => setPane(state);

  /** Flip the pane's visibility (the title-bar toggle). */
  const toggle = (): void => {
    paneApi.toggle().then(apply).catch(() => {});
  };

  /** Show or hide the pane. Hiding keeps the hosted surface alive — the
   * agent's browser keeps running in the background. */
  const setVisible = (visible: boolean): void => {
    paneApi.setVisible(visible).then(apply).catch(() => {});
  };

  return { ...pane, toggle, setVisible };
}
