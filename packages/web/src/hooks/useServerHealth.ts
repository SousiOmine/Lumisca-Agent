import { useCallback, useEffect, useRef, useState } from "preact/compat";
import { onServerFailure, token } from "../api-client.ts";
import { type LocalServerStatus, serverApi } from "../shell.ts";

/** How often the shell is asked about the local server while the page is
 * healthy (the banner only appears once fetches actually fail, so this is
 * just a cheap liveness feed). */
const IDLE_POLL_MS = 5_000;
/** How often the shell is asked once the page looks disconnected: fast
 * enough that a crash is classified (crashed vs. hung) promptly. */
const ALERT_POLL_MS = 2_000;
/** Upper bound for one shell status round-trip. The bridge answers from
 * local state, so a slow answer means "no shell" (plain browser, where a
 * DNS failure can hang) rather than slowness — never stall the loop. */
const STATUS_TIMEOUT_MS = 3_000;
/** A fetch/WS failure younger than this counts as "the server may be
 * down" (transient blips older than this are ignored). */
const FAILURE_FRESHNESS_MS = 30_000;
/** A `running` child that keeps failing its API probe for this long is a
 * hang, not a blip: the banner shows with the log tail for copy-paste. */
const HUNG_AFTER_MS = 10_000;
/** Consecutive healthy API round-trips before the banner clears itself. */
const RECOVER_ROUNDS = 2;

export interface ServerHealth {
  /** The shell's classification of the local server child (null = no
   * shell, i.e. plain browser — the banner never shows there). */
  server: LocalServerStatus | null;
  /** True when the server looks unreachable: recent fetch/WS failures plus
   * the shell confirming the child is gone (`exited`/`none`), or failures
   * persisting while the child is `running` (a hang). The banner then
   * offers restart + log copy-paste. */
  disconnected: boolean;
  /** Record one API/WS failure (call from fetch catch sites / WS onclose). */
  noteFailure: () => void;
  /** Restart the local server through the shell (the banner's button). */
  restart: () => Promise<void>;
  restarting: boolean;
  restartError: string | null;
  /** Dismiss the banner (it reappears on the next fresh failure). */
  dismiss: () => void;
  dismissed: boolean;
}

/** Desktop local-server health: polls the shell bridge (`server/status`)
 * and combines it with client-side failure signals. The page alone cannot
 * tell "server crashed" from "server hung" (both just stop answering), so:
 * - `noteFailure` is called by the API layer / WS handler on errors;
 * - the banner shows when failures are fresh AND the shell says the child
 *   is gone (`exited`/`none`), or when failures persist while the child is
 *   `running` (a hang — the log tail is then the only clue, offered for
 *   copy-paste the same way). Transient blips clear via the healthy-rounds
 *   probe below.
 * Outside the desktop shell (plain browser) the status stays null and the
 * banner never shows — there is no shell to classify or restart. */
export function useServerHealth(active: boolean): ServerHealth {
  const [server, setServer] = useState<LocalServerStatus | null>(null);
  const [lastFailureAt, setLastFailureAt] = useState(0);
  // First failure of the current incident (a hang is "failures persisting
  // for HUNG_AFTER_MS", so the incident start — not the latest failure —
  // is what matters while the child stays alive).
  const [incidentSince, setIncidentSince] = useState(0);
  const [healthyRounds, setHealthyRounds] = useState(RECOVER_ROUNDS);
  const [dismissed, setDismissed] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastFailureAtRef = useRef(lastFailureAt);
  useEffect(() => {
    lastFailureAtRef.current = lastFailureAt;
  }, [lastFailureAt]);

  const noteFailure = useCallback(() => {
    const now = Date.now();
    setLastFailureAt(now);
    // A new incident starts when the previous failure is stale; failures
    // within one incident keep the original start (hang detection).
    setIncidentSince((prev) =>
      now - prev < FAILURE_FRESHNESS_MS && prev !== 0 ? prev : now
    );
    setHealthyRounds(0);
    setDismissed(false);
  }, []);
  const noteFailureRef = useRef(noteFailure);
  useEffect(() => {
    noteFailureRef.current = noteFailure;
  }, [noteFailure]);

  // API-layer failures feed the monitor directly (fetch catch sites call
  // onServerFailure); WS drops arrive here as well via useSessionEvents'
  // onConnectionLost callback wired in App.tsx. The ref keeps the
  // subscription mount-only so the poll loop below never restarts.
  useEffect(() => {
    const unsub = onServerFailure(() => noteFailureRef.current());
    return unsub;
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const poll = async () => {
      let nextDelay = IDLE_POLL_MS;
      try {
        const status = await withStatusTimeout(serverApi.status());
        if (cancelled) return;
        setServer(status);
        const failureFresh =
          Date.now() - lastFailureAtRef.current < FAILURE_FRESHNESS_MS;
        if (!failureFresh) {
          // No recent failure: stay quiet (and reset the banner state so
          // the next incident starts fresh).
          setHealthyRounds(RECOVER_ROUNDS);
          setDismissed(false);
          setRestartError(null);
        } else {
          nextDelay = ALERT_POLL_MS;
          // Probe the API itself (with the token — the desktop server is
          // token-guarded): when it answers again, count a healthy round
          // — the banner clears after consecutive successes even if the
          // shell state lags a restart.
          try {
            const url = token
              ? `/api/health?token=${encodeURIComponent(token)}`
              : "/api/health";
            const res = await fetch(url, { cache: "no-store" });
            if (cancelled) return;
            if (res.ok) {
              setHealthyRounds((r) => Math.min(r + 1, RECOVER_ROUNDS));
            } else {
              setHealthyRounds(0);
            }
          } catch {
            if (!cancelled) setHealthyRounds(0);
          }
        }
      } catch {
        // No shell (plain browser) or a hung bridge: leave the status null
        // — the banner never shows there.
        if (cancelled) return;
        setServer(null);
        nextDelay = IDLE_POLL_MS;
      }
      if (!cancelled) timer.current = setTimeout(poll, nextDelay);
    };

    timer.current = setTimeout(poll, 0);
    return () => {
      cancelled = true;
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
    // Mount-only: the refs above carry the latest failure time without
    // restarting the loop (a restart on every failure would delay the very
    // classification the banner waits for).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const restart = useCallback(async () => {
    setRestarting(true);
    setRestartError(null);
    try {
      await serverApi.restart();
      // Success navigates the whole WebView to the fresh server page.
    } catch (e) {
      setRestartError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestarting(false);
    }
  }, []);

  const dismiss = useCallback(() => setDismissed(true), []);

  const failureFresh = Date.now() - lastFailureAt < FAILURE_FRESHNESS_MS;
  const hung = Date.now() - incidentSince >= HUNG_AFTER_MS;
  // Gone (`exited`/`none`) + fresh failure is "down" right away. A `running`
  // child with failures persisting past HUNG_AFTER_MS is a hang — show the
  // same banner (its log tail is then the only clue). Transient blips
  // (fresh but brief, or already recovering) stay quiet.
  const disconnected = server !== null &&
    failureFresh &&
    healthyRounds < RECOVER_ROUNDS &&
    !dismissed &&
    (server.liveness !== "running" || hung);

  return {
    server,
    disconnected,
    noteFailure,
    restart,
    restarting,
    restartError,
    dismiss,
    dismissed,
  };
}

/** Bound one shell status round-trip: the bridge answers from local state,
 * so anything slower means "no shell" (plain browser DNS hang), not a slow
 * server — never stall the monitor loop on it. */
function withStatusTimeout(
  promise: Promise<LocalServerStatus>,
): Promise<LocalServerStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("server status timeout")),
      STATUS_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
