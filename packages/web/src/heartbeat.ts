import {
  WS_HEARTBEAT_CHECK_MS,
  WS_HEARTBEAT_TIMEOUT_MS,
} from "@lumisca/core/shared";

/** A socket-liveness watchdog for the event stream. */
export interface HeartbeatWatchdog {
  /** A frame arrived: restart the deadline. */
  beat(): void;
  /** Judge the deadline now (a hidden page never judges). */
  check(): void;
  /** Stop watching (the socket is gone, or the watchdog already fired). */
  stop(): void;
}

/**
 * Watches the event stream for silence.
 *
 * The server sends a heartbeat frame on a fixed cadence (see
 * core/shared/heartbeat.ts), so a socket that has been silent past the
 * deadline is dead as far as this page can tell — the caller closes it,
 * which routes into the normal reconnect (and re-sync) path. Any frame
 * counts (`beat()`), not just heartbeats: a busy stream is as alive as an
 * idle one.
 *
 * The judgement is only trusted while the page is visible: a hidden tab's
 * timers are throttled or suspended, so its silence says nothing about the
 * socket. `connectEvents` calls `check()` when a hidden tab returns to the
 * foreground, so a socket that died while the page was hidden is noticed on
 * the first look instead of after the next interval.
 */
export function createHeartbeatWatchdog(options: {
  /** Called once when the socket has been silent past the deadline. */
  onDead: () => void;
  /** Deadline override (tests drive it with a few milliseconds). */
  timeoutMs?: number;
  /** Check-interval override (tests). */
  checkMs?: number;
  /** Whether the page is hidden right now (defaults to document.hidden). */
  isHidden?: () => boolean;
}): HeartbeatWatchdog {
  const timeoutMs = options.timeoutMs ?? WS_HEARTBEAT_TIMEOUT_MS;
  const checkMs = options.checkMs ?? WS_HEARTBEAT_CHECK_MS;
  const isHidden = options.isHidden ?? (() => document.hidden);
  let lastFrameAt = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const check = () => {
    if (stopped || isHidden()) return;
    if (Date.now() - lastFrameAt < timeoutMs) return;
    // Fired once: the caller closes the socket, and a second report of the
    // same death would only schedule a redundant reconnect.
    stop();
    options.onDead();
  };

  timer = setInterval(check, checkMs);

  return {
    beat: () => {
      lastFrameAt = Date.now();
    },
    check,
    stop,
  };
}
