import { useCallback, useEffect, useRef, useState } from "preact/compat";
import { api } from "../api.ts";
import { errorText } from "../providers.ts";
import type { AppModeStatus } from "../types.ts";

/** The mode the app is in, and whether stella can run on this server.
 *
 * Read once at startup (the status carries both facts) and re-read after
 * every change, so the machine's state shown on screen is always the one the
 * server has — never a client-side guess that a `podman` call later
 * contradicts.
 *
 * Changing the mode is optimistic for `code` (nothing can fail) and
 * server-confirmed for `stella` (switching there refuses on a host without a
 * usable machine, and the refusal is the whole point: the mode must never be
 * entered in a state where its tools cannot work). */
export function useAppMode(): {
  /** null while the status is still loading, or while no mode is chosen. */
  status: AppModeStatus | null;
  loading: boolean;
  error: string | null;
  setMode: (mode: "code" | "stella") => Promise<void>;
  /** Re-read the status (after starting/stopping/resetting the machine). */
  reload: () => Promise<void>;
  setStatus: (status: AppModeStatus) => void;
} {
  const [status, setStatus] = useState<AppModeStatus | null>(null);
  const [loading, setLoading] = useState(true);
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
    } finally {
      if (generation.current === mine) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setMode = useCallback(async (mode: "code" | "stella") => {
    setError(null);
    try {
      setStatus(await api.setAppMode(mode));
    } catch (failure) {
      // A refusal (stella on a host without a usable machine) is reported
      // where the user made the choice; the mode stays what it was.
      setError(errorText(failure));
      throw failure;
    }
  }, [reload]);

  return { status, loading, error, setMode, reload, setStatus };
}
