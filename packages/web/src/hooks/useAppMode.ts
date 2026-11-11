import { type AppMode, isAppMode } from "@lumisca/core/shared";
import { useCallback, useEffect, useRef, useState } from "preact/compat";
import { api } from "../api.ts";
import { errorText } from "../providers.ts";
import type { StellaStatus } from "../types.ts";
import { NEVER, useVisibleInterval } from "./useVisibleInterval.ts";

/** localStorage key of this client's chosen mode. Per browser profile and per
 * origin, which is exactly the scope the choice has: two clients showing one
 * server (the desktop window and a browser, or two browsers) each pick their
 * own, and switching in one never reaches the other. */
const MODE_KEY = "lumisca.appMode";

/**
 * The mode a bare `/` resolves to: the one this client showed last, or null
 * when it has never chosen.
 *
 * The stored value is not what the app SHOWS — the URL is (route.ts) — but
 * what the address every launch starts from means. `/` is what the desktop
 * shell and an installed PWA open, so storing the choice is what makes "start
 * where I left off" work without putting a mode in the start URL (which the
 * manifest may not carry a capability in, and which a bare link should not
 * force anyway).
 */
export function storedMode(): AppMode | null {
  const raw = localStorage.getItem(MODE_KEY);
  return isAppMode(raw) ? raw : null;
}

/** Remember the mode this client is showing, for the next bare `/`. */
export function rememberMode(mode: AppMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // A storage that refuses writes (private mode, a full quota) costs the
    // reader only the remembered start screen: the address still says which
    // mode this page shows.
  }
}

/**
 * What the server can do for stella mode, and the one refusal a mode choice
 * has to make.
 *
 * The mode itself belongs to the URL (route.ts): `/code` and `/stella` say
 * which mode this page shows, so this hook takes the mode it was given
 * rather than owning it. What stays here is the SERVER's half — whether a
 * machine can run at all, and how it is doing — polled while stella is the
 * mode, because the machine starts itself when a conversation needs it and
 * the client has to learn when it is up.
 *
 * `choose` is what the chooser calls: it refuses stella where the server
 * cannot run it (a mode whose whole premise is a virtual machine has no
 * honest degraded form). Navigating is the caller's — the URL is where the
 * answer is written.
 */
export function useAppMode(mode: AppMode | null): {
  /** What this server can do for stella mode, and how its machine is doing.
   * null while the first read is in flight. */
  status: StellaStatus | null;
  error: string | null;
  /** Validate `next`; rejects when the server refuses it. */
  choose: (next: AppMode) => Promise<void>;
  /** Re-read the machine's status (the poll, and after a switch). */
  reload: () => Promise<void>;
} {
  const [status, setStatus] = useState<StellaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards against a stale response: the machine's status is polled and
  // changed by the user, and the slower answer must not overwrite the newer.
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await api.getStellaStatus();
      if (generation.current !== mine) return;
      setStatus(next);
      setError(null);
    } catch (failure) {
      if (generation.current !== mine) return;
      setError(errorText(failure));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The machine can change state without the user doing anything (a
  // conversation starts it, a first run finishes building it), so stella's
  // status is followed on a slow interval. 3s is fast enough that the screen
  // pane appears as soon as the machine is up, and slow enough that a
  // `podman` call per tick is not a load. A hidden page never polls (see
  // useVisibleInterval): the machine cannot be watched while nobody looks.
  useVisibleInterval(() => void reload(), mode === "stella" ? 3_000 : NEVER);

  const choose = useCallback(async (next: AppMode) => {
    setError(null);
    if (next === "stella") {
      // The verdict is read now rather than reused: a machine that appeared
      // since the last poll (podman installed) must not be refused from a
      // stale answer, and a mode the server refuses is never rememberable.
      try {
        const current = await api.getStellaStatus();
        setStatus(current);
        if (!current.availability.available) {
          throw new Error(current.availability.reason);
        }
      } catch (failure) {
        setError(errorText(failure));
        throw failure;
      }
    }
  }, []);

  return { status, error, choose, reload };
}
