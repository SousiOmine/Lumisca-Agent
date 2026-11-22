import { errorMessage } from "@lumisca/core/shared";
import { useCallback, useEffect, useState } from "preact/hooks";
import { displayedLabel, useConnections } from "../connections.ts";
import { useT } from "../i18n.ts";
import {
  inDesktopShell,
  type ShellState,
  shellCall,
  shellState,
} from "../shell.ts";
import type { ConnectionSummary } from "../types.ts";

/** Which server this window shows, and how to show another one. */
export interface ConnectionSwitch {
  /** Whether a shell bridge exists at all. */
  desktop: boolean;
  /** The shell's answer, or null while it is being read (and in a browser). */
  state: ShellState | null;
  /** The rows the picker offers. Empty in a plain browser: the list belongs
   * to the shell, and a page served by a remote server does not have one. */
  entries: ConnectionSummary[];
  /** The row being switched to ("" for the local server), or null. */
  busy: string | null;
  error: string | null;
  /** The displayed row's id, or null for the local server. The shell
   * records it when it switches; there is no URL matching left to do. */
  currentId: string | null;
  /** What to call the displayed server. */
  currentLabel: () => string;
  /** Switch the window. The shell owns the navigation, so a successful call
   * replaces this page with the chosen server. The answer says whether the
   * switch happened, so a surface can keep its list open on a failure. */
  connect: (target: { id: string } | "local") => Promise<boolean>;
}

/**
 * The one place the settings dialog and the title bar ask "which server is
 * this, and how do I show another one".
 *
 * Both used to hold their own copy of the shell read, the registry lookup and
 * the switch. The copies drifted in exactly the way copies do: the settings
 * list navigated from the page and the title bar asked the shell, so one of
 * the two could show a name the other could not.
 *
 * The list and the current row are both the shell's. A remote page's own
 * server is just the machine that served the page; it is not where the
 * window keeps the list of other servers it may show.
 */
export function useConnectionSwitch(): ConnectionSwitch {
  const t = useT();
  const desktop = inDesktopShell();
  const { entries } = useConnections();
  const [state, setState] = useState<ShellState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let stale = false;
    shellState
      .read()
      .then((next) => {
        if (!stale) setState(next);
      })
      .catch((failure: unknown) => {
        if (!stale) setError(errorMessage(failure));
      });
    return () => {
      stale = true;
    };
  }, [desktop]);

  const currentId = state?.connectionId ?? null;

  const currentLabel = useCallback((): string => {
    // A browser has no bridge: the address bar is the answer, and its host is
    // the one thing this page can name without asking anyone.
    if (!desktop) return globalThis.location?.host ?? "";
    if (state === null) return t("common.loading");
    if (state.mode === "local") return t("chrome.connections.local");
    const label = displayedLabel(entries, currentId, state.url);
    return label === "" ? t("common.loading") : label;
  }, [desktop, state, entries, currentId, t]);

  const connect = useCallback(
    async (target: { id: string } | "local"): Promise<boolean> => {
      setBusy(target === "local" ? "" : target.id);
      setError(null);
      try {
        if (target === "local") {
          await shellCall("connect-local");
        } else {
          // The shell looks the row up in its own list: a page served by a
          // remote server must not name an arbitrary address here.
          await shellCall("connect-remote", { id: target.id });
        }
        return true;
      } catch (failure) {
        setError(errorMessage(failure));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  return {
    desktop,
    state,
    entries,
    busy,
    error,
    currentId,
    currentLabel,
    connect,
  };
}
