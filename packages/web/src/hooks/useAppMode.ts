import { useCallback, useEffect, useRef, useState } from "preact/compat";
import { type AppMode, isAppMode } from "@lumisca/core/shared";
import { api } from "../api.ts";
import { NEVER, useVisibleInterval } from "./useVisibleInterval.ts";
import { errorText } from "../providers.ts";
import type { StellaStatus } from "../types.ts";

/** localStorage key of this client's chosen mode. Per browser profile and per
 * origin, which is exactly the scope the choice has: two clients showing one
 * server (the desktop window and a browser, or two browsers) each pick their
 * own, and switching in one never reaches the other. */
const MODE_KEY = "lumisca.appMode";

/** Read the stored mode. An unset or unrecognised value is "not chosen"
 * (the selection screen), never a silent default. */
function storedMode(): AppMode | null {
  const raw = localStorage.getItem(MODE_KEY);
  return isAppMode(raw) ? raw : null;
}

/**
 * The mode this client shows, and what the server it talks to can do.
 *
 * The two facts have different homes. The mode belongs to the CLIENT
 * (localStorage): it describes a view, so the desktop window may be in code
 * mode while a browser on the same server is in stella mode, and neither may
 * flip the other. The machine's status belongs to the SERVER and is re-read
 * after every switch and — in stella mode — on a slow interval, because the
 * machine starts itself when a conversation needs it: the client has to learn
 * when it is up (to connect the screen) and when a first-run build is still
 * going. Nothing polls in code mode.
 *
 * Picking stella is refused where the server says it cannot run: a mode whose
 * whole premise is a virtual machine has no honest degraded form, and the
 * refusal is shown where the choice was made.
 */
export function useAppMode(): {
  /** The mode this client shows, or null until it picks one (the selection
   * screen). */
  mode: AppMode | null;
  /** What this server can do for stella mode, and how its machine is doing.
   * null while the first read is in flight. */
  status: StellaStatus | null;
  error: string | null;
  setMode: (mode: AppMode) => Promise<void>;
  /** Re-read the machine's status (the poll, and after a switch). */
  reload: () => Promise<void>;
} {
  const [status, setStatus] = useState<StellaStatus | null>(null);
  const [mode, setModeState] = useState<AppMode | null>(storedMode);
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

  const setMode = useCallback(async (next: AppMode) => {
    setError(null);
    if (next === "stella") {
      // The verdict is read now rather than reused: a machine that appeared
      // since the last poll (podman installed) must not be refused from a
      // stale answer, and a refused mode must never be stored.
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
    localStorage.setItem(MODE_KEY, next);
    setModeState(next);
  }, []);

  return { mode, status, error, setMode, reload };
}
