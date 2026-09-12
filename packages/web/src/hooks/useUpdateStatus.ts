import { useEffect, useRef, useState } from "preact/compat";
import { errorMessage as errorText } from "@lumisca/core/shared";
import {
  serverUpdateApi,
  shellAvailable,
  updateApi,
  type UpdateStatus,
} from "../shell.ts";

/** Poll interval while a check/download is in flight (progress bar) vs
 * idle (the update banner may appear at any time). */
const BUSY_POLL_MS = 1_000;
const IDLE_POLL_MS = 60_000;

/** Which updater reported the state: the desktop shell (the app the user
 * launched) or the standalone server hosting this page. */
export type UpdateSource = "shell" | "server";

/** Auto-update actions shared by the settings panel and the banner. Some
 * actions only exist on one side (the desktop shell restarts itself when it
 * installs, so it has no restart action of its own); components check
 * {@link UpdateControls.source} before offering them. */
export interface UpdateControls {
  /** null = no updater reachable (plain browser against a development
   * server, or the shell bridge is down). */
  status: UpdateStatus | null;
  /** Which updater answered (null = none); also the app's desktop-mode
   * signal. */
  source: UpdateSource | null;
  setAuto: (enabled: boolean) => void;
  check: () => void;
  download: () => void;
  install: () => void;
  /** Standalone server only: restart into the applied version. */
  restart: () => void;
  /** Standalone server only: restart automatically once an update is
   * applied. */
  setAutoRestart: (enabled: boolean) => void;
  /** Last bridge/API failure that left the displayed state stale, null when
   * the last call succeeded. Shown in the settings' general panel: a
   * silently ignored failure would leave the update state frozen with no
   * explanation. */
  error: string | null;
}

/** Auto-update state. Prefers the desktop shell bridge (that updater owns
 * the app the user launched) and falls back to the server's own updater
 * (`/api/update/*`), which is what a packaged server opened in a browser
 * has. Single instance in App.tsx, passed down to the settings panel and the
 * update banner so neither is polled twice. */
export function useUpdateStatus(active: boolean): UpdateControls {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [source, setSource] = useState<UpdateSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const fastPollUntilRef = useRef(0);
  const [pollGeneration, setPollGeneration] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const shell = await shellAvailable();
      if (cancelled) return;
      if (shell) {
        try {
          const next = await updateApi.status();
          if (cancelled) return;
          setStatus(next);
          setSource("shell");
          setError(null);
          busyRef.current = next.checking || next.downloading;
        } catch (failure) {
          // Bridge unreachable or the shell refused: keep the last status
          // but say why it may be stale, then retry on the next interval.
          if (cancelled) return;
          setError(errorText(failure));
        }
      } else {
        // No shell: the page may be served by a packaged server, whose own
        // updater answers here. A development server has no such routes
        // (404) — that is "no controls", not an error to report.
        try {
          const next = await serverUpdateApi.status();
          if (cancelled) return;
          setStatus(next);
          setSource("server");
          setError(null);
          busyRef.current = next.checking || next.downloading;
        } catch {
          if (cancelled) return;
          setStatus(null);
          setSource(null);
          setError(null);
        }
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

  /** Run an action and adopt the returned status immediately. The shell (or
   * the server) reports it before the async work has started, so poll fast
   * until the next poll picks up the checking/downloading flags. */
  const run = async (action: () => Promise<UpdateStatus>): Promise<void> => {
    busyRef.current = true;
    // Actions start their async work after returning. Wake the polling
    // effect now and keep it fast long enough to observe that transition.
    fastPollUntilRef.current = Date.now() + 5_000;
    setPollGeneration((generation) => generation + 1);
    try {
      setStatus(await action());
      setError(null);
    } catch (failure) {
      // The poll loop keeps the displayed state in sync; the message is
      // for the user, not for the console.
      setError(errorText(failure));
    }
  };

  // Actions go to whichever updater answered the last poll; before the
  // first answer they are no-ops (there is nothing to drive yet).
  const call = (
    shellAction: () => Promise<UpdateStatus>,
    serverAction: () => Promise<UpdateStatus>,
  ) =>
  () => {
    if (source === null) return;
    return run(source === "shell" ? shellAction : serverAction);
  };

  return {
    status,
    source,
    error,
    setAuto: (enabled: boolean) => {
      if (source === null) return;
      void run(
        source === "shell"
          ? () => updateApi.setAuto(enabled)
          : () => serverUpdateApi.setAuto(enabled),
      );
    },
    check: call(
      () => updateApi.check(),
      () => serverUpdateApi.check(),
    ),
    download: call(
      () => updateApi.download(),
      () => serverUpdateApi.download(),
    ),
    install: call(
      () => updateApi.install(),
      () => serverUpdateApi.install(),
    ),
    restart: () => {
      if (source !== "server") return;
      void run(() => serverUpdateApi.restart());
    },
    setAutoRestart: (enabled: boolean) => {
      if (source !== "server") return;
      void run(() => serverUpdateApi.setAutoRestart(enabled));
    },
  };
}
