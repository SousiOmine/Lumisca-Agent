import { useEffect, useRef, useState } from "react";
import { shellAvailable, updateApi, type UpdateStatus } from "../shell.ts";

/** Poll interval while a check/download is in flight (progress bar) vs
 * idle (the update banner may appear at any time). */
const BUSY_POLL_MS = 1_000;
const IDLE_POLL_MS = 60_000;

/** Auto-update actions shared by the settings panel and the banner. */
export interface UpdateControls {
  /** null = desktop shell unreachable (plain browser). */
  status: UpdateStatus | null;
  setAuto: (enabled: boolean) => void;
  check: () => void;
  download: () => void;
  install: () => void;
}

/** Desktop auto-update state. Polls the shell bridge; single instance in
 * App.tsx, passed down to the settings panel and the update banner so the
 * bridge is not polled twice. No-op (status null) outside the desktop
 * shell, where the bridge is unreachable. */
export function useUpdateStatus(active: boolean): UpdateControls {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const busyRef = useRef(false);
  const fastPollUntilRef = useRef(0);
  const [pollGeneration, setPollGeneration] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const ok = await shellAvailable();
      if (cancelled) return;
      if (!ok) {
        timer = setTimeout(poll, IDLE_POLL_MS);
        return;
      }
      try {
        const next = await updateApi.status();
        if (cancelled) return;
        setStatus(next);
        busyRef.current = next.checking || next.downloading;
      } catch {
        // Bridge unreachable; try again on the next interval.
      }
      if (cancelled) return;
      const pollFast = busyRef.current || Date.now() < fastPollUntilRef.current;
      timer = setTimeout(poll, pollFast ? BUSY_POLL_MS : IDLE_POLL_MS);
    };

    timer = setTimeout(poll, 0);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, pollGeneration]);

  /** Run an action and adopt the returned status immediately. The shell
   * reports it before the async work has started, so poll fast until the
   * next poll picks up the checking/downloading flags. */
  const run = async (action: () => Promise<UpdateStatus>): Promise<void> => {
    busyRef.current = true;
    // Shell actions start their async work after returning. Wake the polling
    // effect now and keep it fast long enough to observe that transition.
    fastPollUntilRef.current = Date.now() + 5_000;
    setPollGeneration((generation) => generation + 1);
    try {
      setStatus(await action());
    } catch {
      // The poll loop keeps the displayed state in sync.
    }
  };

  return {
    status,
    setAuto: (enabled: boolean) => run(() => updateApi.setAuto(enabled)),
    check: () => run(() => updateApi.check()),
    download: () => run(() => updateApi.download()),
    install: () => run(() => updateApi.install()),
  };
}
