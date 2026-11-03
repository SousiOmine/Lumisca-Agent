/**
 * Reconnecting an event stream: the backoff both streams share.
 *
 * The app keeps two WebSocket streams open (`/ws` for code mode's sessions and
 * a conversation's own for stella), and both reconnect the same way: wait
 * 2 s, double on each failure, stop growing at 30 s, and reset to the base
 * when a connection succeeds. The rule lived in two hooks with its own copy of
 * the two constants, so the pair could drift — one stream retrying every 2 s
 * forever while the other backs off is a difference nobody chose.
 *
 * The scheduler owns the timer and the attempt count and nothing else: what
 * to run on a retry, and what to do when a connection opens, are the caller's.
 */

/** Wait before the first retry of a broken stream. */
export const RECONNECT_BASE_MS = 2000;

/** Longest wait between retries: a background tab with a dead socket must
 * not keep retrying at the base cadence forever. */
export const RECONNECT_MAX_MS = 30_000;

export interface ReconnectScheduler {
  /** Schedule the next attempt (a no-op while one is already scheduled).
   * `attempt` is what the caller would run: usually its connect function. */
  schedule(attempt: () => void): void;
  /** Cancel a scheduled attempt. */
  cancel(): void;
  /** A connection opened: the next failure starts the backoff over. */
  reset(): void;
}

export function createReconnectScheduler(
  options: {
    /** Whether a scheduled attempt should be dropped (the caller closed). */
    stopped?: () => boolean;
    baseMs?: number;
    maxMs?: number;
  } = {},
): ReconnectScheduler {
  const base = options.baseMs ?? RECONNECT_BASE_MS;
  const max = options.maxMs ?? RECONNECT_MAX_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;

  return {
    schedule(attempt) {
      if (timer !== undefined || options.stopped?.() === true) return;
      // Double per failure, capped. `2 ** attempts` overflows into Infinity
      // long before the cap would apply, so the cap is what keeps a stream
      // that stays down from scheduling a retry millennia away.
      const delay = Math.min(base * 2 ** attempts, max);
      attempts++;
      timer = setTimeout(() => {
        timer = undefined;
        attempt();
      }, delay);
    },
    cancel() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    },
    reset() {
      attempts = 0;
    },
  };
}
