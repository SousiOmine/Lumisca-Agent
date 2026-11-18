import { errorMessage } from "@lumisca/core/shared";
import { useCallback, useEffect, useState } from "preact/hooks";
import {
  connectionLabel,
  displayedConnectionId,
  serverLabel,
  useConnections,
} from "../connections.ts";
import { useT } from "../i18n.ts";
import {
  inDesktopShell,
  type ShellState,
  shellCall,
  shellState,
} from "../shell.ts";
import type { ConnectionEntry } from "../types.ts";

/** Which server this window shows, and how to show another one. */
export interface ConnectionSwitch {
  /** Whether a shell bridge exists at all. */
  desktop: boolean;
  /** The shell's answer, or null while it is being read (and in a browser). */
  state: ShellState | null;
  /** The registry entries the picker offers. */
  entries: ConnectionEntry[];
  /** The entry being switched to ("" for the local server), or null. */
  busy: string | null;
  error: string | null;
  /** The displayed registry entry, "" for the local server, null for a
   * server the page's registry does not contain. */
  currentId: string | null;
  /** What to call the displayed server. */
  currentLabel: () => string;
  /** Switch the window. The shell owns the navigation, so a successful call
   * replaces this page with the chosen server. The answer says whether the
   * switch happened, so a surface can keep its list open on a failure. */
  connect: (target: ConnectionEntry | "local") => Promise<boolean>;
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
 * The name is the shell's, not the registry's: a remote page's registry is
 * that server's own, which usually has no entry for itself. The shell
 * remembers the name it was switched with and reports it in `state`.
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

  const currentId = displayedConnectionId(entries, state);

  const currentLabel = useCallback((): string => {
    // A browser has no bridge: the address bar is the answer, and its host is
    // the one thing this page can name without asking anyone.
    if (!desktop) return globalThis.location?.host ?? "";
    if (state === null) return t("common.loading");
    if (state.mode === "local") return t("chrome.connections.local");
    const entry = entries.find((server) => server.id === currentId);
    if (entry !== undefined) return connectionLabel(entry);
    return serverLabel(state.name, state.url);
  }, [desktop, state, entries, currentId, t]);

  const connect = useCallback(
    async (target: ConnectionEntry | "local"): Promise<boolean> => {
      setBusy(target === "local" ? "" : target.id);
      setError(null);
      try {
        if (target === "local") {
          await shellCall("connect-local");
        } else {
          // The name travels with the switch because the page that loads next
          // cannot look it up: a remote page's registry is that server's own.
          await shellCall("connect-remote", {
            url: target.url.trim(),
            token: target.token,
            name: connectionLabel(target),
          });
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
