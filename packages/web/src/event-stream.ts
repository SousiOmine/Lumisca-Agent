import { WS_HEARTBEAT_TYPE } from "@lumisca/core/shared";
import {
  createHeartbeatWatchdog,
  type HeartbeatWatchdog,
} from "./heartbeat.ts";
import { token } from "./api-client.ts";

/**
 * One WebSocket event stream, with the liveness and lifecycle handling every
 * stream shares.
 *
 * The app has two streams — `/ws` (a code-mode session's events) and
 * `/api/stella/conversations/:agentId/events` (a stella conversation's) —
 * and they differ ONLY in their path and the shape of the frames. The rest
 * (the ws/wss choice, the token in the query because browsers cannot set a
 * WebSocket header, the heartbeat watchdog, the visibility handling, the
 * swallow of transport-level frames) was written twice and drifted: a fix to
 * the watchdog or the reconnect had to be made in both places, and only one
 * of them was always made.
 *
 * `onClose` fires for a socket that was not closed by the returned closer —
 * the caller's reconnect path. `onOpen` fires on every (re)connection so the
 * caller can re-sync state.
 */
export interface EventStreamOptions {
  /** Path of the stream on this origin ("" = this server), query excluded. */
  path: string;
  /** Timing overrides for the watchdog (tests drive it with tiny values). */
  timings?: { heartbeatTimeoutMs?: number; heartbeatCheckMs?: number };
}

export function openEventStream<T>(
  options: EventStreamOptions,
  onEvent: (event: T) => void,
  onClose: () => void,
  onOpen?: () => void,
): () => void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // Browsers cannot set WS headers, so an enabled token travels in the URL.
  const suffix = token ? `?token=${encodeURIComponent(token)}` : "";
  const ws = new WebSocket(
    `${proto}//${location.host}${options.path}${suffix}`,
  );
  let closed = false;

  const watchdog = createWatchdog(options.timings, () => {
    // Closing is the recovery: onclose re-syncs and reconnects.
    try {
      ws.close();
    } catch {
      // already closed
    }
  });
  // A hidden page's timers are throttled, so its silence is not evidence;
  // judge the deadline as soon as the page is visible again.
  const onVisibility = () => {
    if (!document.hidden) watchdog.check();
  };
  document.addEventListener("visibilitychange", onVisibility);

  ws.onopen = () => {
    watchdog.beat();
    onOpen?.();
  };
  ws.onmessage = (e) => {
    watchdog.beat();
    try {
      const parsed = JSON.parse(String(e.data)) as { type?: string };
      // Heartbeats are transport-level: they never reach the caller.
      if (parsed?.type === WS_HEARTBEAT_TYPE) return;
      onEvent(parsed as T);
    } catch {
      // ignore malformed messages
    }
  };
  ws.onclose = () => {
    watchdog.stop();
    if (!closed) onClose();
  };

  return () => {
    closed = true;
    watchdog.stop();
    document.removeEventListener("visibilitychange", onVisibility);
    ws.close();
  };
}

function createWatchdog(
  timings: EventStreamOptions["timings"],
  onDead: () => void,
): HeartbeatWatchdog {
  return createHeartbeatWatchdog({
    onDead,
    ...(timings?.heartbeatTimeoutMs === undefined
      ? {}
      : { timeoutMs: timings.heartbeatTimeoutMs }),
    ...(timings?.heartbeatCheckMs === undefined
      ? {}
      : { checkMs: timings.heartbeatCheckMs }),
  });
}
