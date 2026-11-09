import type { ClientEvent } from "../domain/event.ts";

/**
 * The core's event fan-out: the revision counter and the subscribers.
 *
 * Every session event passes through {@link emit} (the agent, the ask and
 * todo hubs, the background manager, the task hub, the stella machine), which
 * is what makes the revision a count of events rather than a guess. A client
 * compares its own count with {@link getSessionRevision} to tell "I have seen
 * everything" from "I missed a frame" (see the web's useSessionEvents).
 *
 * A listener's failure is swallowed: one broken sink must not stop the
 * others, and a sink is a transport (a WebSocket writer), not a participant
 * in the run. Policies that react to an event (a pending model rebuild
 * released by `agent_end`) subscribe here instead of being written into the
 * fan-out.
 */
export class EventHub {
  private readonly listeners = new Set<(event: ClientEvent) => void>();
  private readonly revisions = new Map<string, number>();

  /** Subscribe to every event. Returns the unsubscribe function. */
  subscribe(listener: (event: ClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Count the event (when it belongs to a session) and hand it to every
   * subscriber, in subscription order. */
  emit(event: ClientEvent): void {
    if ("sessionId" in event) {
      const sessionId = event.sessionId;
      this.revisions.set(
        sessionId,
        (this.revisions.get(sessionId) ?? 0) + 1,
      );
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore sink failures
      }
    }
  }

  /** How many events this server has emitted for the session over the life
   * of the process (0 when none, or after the session was closed and
   * reopened). The count travels with every frame of the event stream and
   * with the session snapshot, so a client can tell "I have seen
   * everything" from "I missed something": the stream is ordered and
   * reliable while it is up, so a jump in the count means frames were lost,
   * and a count behind the server's means the view is stale.
   *
   * This is a delivery check, not a content check: it cannot see state that
   * changed without an event. */
  getSessionRevision(id: string): number {
    return this.revisions.get(id) ?? 0;
  }

  /** Drop the counter of a session that no longer exists. Without this the
   * map grows for the life of the process (a workstation server opens
   * hundreds of sessions). */
  forgetSession(id: string): void {
    this.revisions.delete(id);
  }

  /** The sessions that have a counter (the shutdown sweep closes every
   * session and then forgets what is left). */
  sessionIds(): Iterable<string> {
    return this.revisions.keys();
  }
}
