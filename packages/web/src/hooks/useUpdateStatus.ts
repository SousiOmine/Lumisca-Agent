import { useEffect, useRef, useState } from "preact/compat";
import { errorMessage as errorText } from "@lumisca/core/shared";
import { ApiError } from "../api-client.ts";
import {
  serverUpdateApi,
  shellAvailable,
  updateApi,
  type UpdateStatus,
} from "../shell.ts";

/** Poll interval while a check/download/install is in flight (progress bar,
 * "installing…") vs idle (the update banner may appear at any time). */
const BUSY_POLL_MS = 1_000;
const IDLE_POLL_MS = 60_000;

/** Whether an action is in flight, i.e. the state will move on its own. A
 * fast poll is what puts that movement (and the end of it) on screen. */
function isBusy(status: UpdateStatus): boolean {
  return status.checking || status.downloading || status.installing === true;
}

/** Which updater reported the state: the desktop shell (the app the user
 * launched) or the standalone server hosting this page. */
export type UpdateSource = "shell" | "server";

/** Why the server's updater could not be read, in the terms the reader can
 * act on. `no-updater`: it answered, but this installation has no updater (a
 * development run, or a server the desktop app manages). `unauthorized`: the
 * token was refused. `unreachable`: nothing answered. `failed`: anything
 * else, with the message kept. */
export type UpdateFailureKind =
  | "no-updater"
  | "unauthorized"
  | "unreachable"
  | "failed";

/** Classify one failed read of `/api/update/*`. Exported so the mapping is
 * testable without a server. */
export function classifyUpdateFailure(failure: unknown): UpdateFailureKind {
  if (!(failure instanceof ApiError)) return "failed";
  if (failure.kind === "network") return "unreachable";
  if (failure.status === 401 || failure.status === 403) return "unauthorized";
  if (failure.status === 404 || failure.status === 405) return "no-updater";
  return "failed";
}

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
  /** Standalone server only: set once this page asked for a restart the
   * server accepted. From then on the page waits for the successor, and the
   * one thing it has to do when it answers is reload (see useBuildWatch). */
  restartRequested: boolean;
  /** Last bridge/API failure that left the displayed state stale, null when
   * the last call succeeded. Shown in the settings' general panel: a
   * silently ignored failure would leave the update state frozen with no
   * explanation. */
  error: string | null;
  /** The same failure, classified when the server's updater was the one that
   * failed (`error` alone cannot say whether the installation has no updater
   * or the request never arrived). Null while the shell answered, and after
   * every successful read. */
  failure: UpdateFailureKind | null;
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
  const [failure, setFailure] = useState<UpdateFailureKind | null>(null);
  const [restartRequested, setRestartRequested] = useState(false);
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
          setFailure(null);
          busyRef.current = isBusy(next);
        } catch (failure) {
          // Bridge unreachable or the shell refused: keep the last status
          // but say why it may be stale, then retry on the next interval.
          if (cancelled) return;
          setError(errorText(failure));
        }
      } else {
        // No shell: the page may be served by a packaged server, whose own
        // updater answers here. A development server has no such routes
        // (404), and a server the desktop app manages answers nothing —
        // both are "no updater", which the panel has to say instead of
        // pretending the controls are missing.
        try {
          const next = await serverUpdateApi.status();
          if (cancelled) return;
          setStatus(next);
          setSource("server");
          setError(null);
          setFailure(null);
          busyRef.current = isBusy(next);
        } catch (failure) {
          if (cancelled) return;
          // Keep the last status and source: an unreachable server is
          // usually a restart, and the state it reported a moment ago is
          // still the best one to show. Only the reason is new.
          setFailure(classifyUpdateFailure(failure));
          setError(errorText(failure));
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
   * until the next poll picks up the checking/downloading flags. Resolves
   * with the reported status, or undefined when the action failed. */
  const run = async (
    action: () => Promise<UpdateStatus>,
  ): Promise<UpdateStatus | undefined> => {
    busyRef.current = true;
    // Actions start their async work after returning. Wake the polling
    // effect now and keep it fast long enough to observe that transition.
    fastPollUntilRef.current = Date.now() + 5_000;
    setPollGeneration((generation) => generation + 1);
    try {
      const next = await action();
      setStatus(next);
      setError(null);
      setFailure(null);
      return next;
    } catch (failure) {
      // The poll loop keeps the displayed state in sync; the message is
      // for the user, not for the console.
      setError(errorText(failure));
      return undefined;
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
    failure,
    restartRequested,
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
      void run(() => serverUpdateApi.restart()).then((next) => {
        // The server exits after answering this request. From here the page
        // waits for the successor, and the one thing it has to do when it
        // answers is load the new client (App.tsx turns this flag into a
        // reload once the build changes).
        if (next?.restarting === true) setRestartRequested(true);
      });
    },
    setAutoRestart: (enabled: boolean) => {
      if (source !== "server") return;
      void run(() => serverUpdateApi.setAutoRestart(enabled));
    },
  };
}
