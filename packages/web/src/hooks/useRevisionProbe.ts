/**
 * The revision probe both event streams run.
 *
 * A WebSocket that died without a close event, or a hub that dropped a
 * relayed frame, leaves a view showing a conversation that has moved on. The
 * socket's heartbeat catches the first case eventually; this probe catches
 * both within one interval, for one tiny request per watched session.
 *
 * The rule is the same for a code-mode session and a stella conversation:
 * read the revision counter, and when it no longer matches what this view has
 * seen, re-read the state. The two used to carry their own copy of the
 * constant and the loop (useSessionEvents.ts and useStella.ts), which is how
 * one of them silently keeps the old interval the next time it changes.
 */

/** How often an open view verifies that it has seen every event. */
export const REVISION_PROBE_MS = 30_000;

export interface RevisionProbeOptions {
  /** Read the revision this view has seen, per key. Undefined before the
   * first read: that tick only records the value (an unseeded view would
   * otherwise treat every tick as a gap). */
  knownRevision(key: string): number | undefined;
  /** Record the revision a read returned, so the next tick compares against
   * it. Called after every successful read, including the seeding one. */
  remember(key: string, revision: number): void;
  /** Read the revision the server is at, per key. */
  readRevision(key: string): Promise<number>;
  /** Called when a key's revision moved: re-read that key's state. */
  onMoved(key: string): void;
  /** The keys to probe. Read on every tick, so a tab opening or closing is
   * picked up without restarting the timer. */
  keys(): Iterable<string>;
  /** Skip the tick entirely (the socket is down; reconnecting is the path). */
  enabled(): boolean;
  /** Set when the owner has torn down: a probe in flight resolves into
   * nothing instead of touching a disposed view. */
  disposed(): boolean;
  intervalMs?: number;
}

/**
 * Start the probe. Returns the stop function (clears the timer).
 *
 * A failed probe is not a state change — the next tick retries, and the
 * heartbeat watchdog is what decides a socket is dead.
 */
export function startRevisionProbe(options: RevisionProbeOptions): () => void {
  const timer = setInterval(() => {
    void probeOnce(options);
  }, options.intervalMs ?? REVISION_PROBE_MS);
  return () => clearInterval(timer);
}

/** One pass over the keys. Exported so a test can drive it without timers. */
export async function probeOnce(options: RevisionProbeOptions): Promise<void> {
  if (options.disposed() || !options.enabled()) return;
  // Snapshot the keys: a probe may open or close a tab while it runs.
  const keys = [...options.keys()];
  for (const key of keys) {
    try {
      const rev = await options.readRevision(key);
      // The view may have been disposed, or the key closed, while the
      // request was in flight.
      if (options.disposed()) return;
      if (![...options.keys()].includes(key)) continue;
      // The marker may have moved while the request was in flight (an event
      // arrived): compare against the fresh value.
      const known = options.knownRevision(key);
      options.remember(key, rev);
      // The first read only seeds the marker.
      if (known !== undefined && rev !== known) options.onMoved(key);
    } catch {
      // Opportunistic: a failed probe is not a state change.
    }
  }
}
