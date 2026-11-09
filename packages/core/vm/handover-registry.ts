import type { ClientEvent } from "../domain/event.ts";
import { HandoverHub } from "./handover.ts";

/**
 * The hand-over hub of each session that ever asked for the screen.
 *
 * A hub lives as long as its session does. The registry is the one place
 * that owns the map, so the close, delete and shutdown paths drop a session's
 * hub by calling {@link forget} instead of reaching into a map the facade
 * happens to hold. Hubs are created on demand: a session that never hands the
 * screen over has no entry.
 */
export class HandoverRegistry {
  private readonly hubs = new Map<string, HandoverHub>();

  /** `emit` publishes the hub's events to every frontend listener. */
  constructor(private readonly emit: (event: ClientEvent) => void) {}

  /** The hub of a session, created on first use. */
  for(sessionId: string): HandoverHub {
    const existing = this.hubs.get(sessionId);
    if (existing !== undefined) return existing;
    const hub = new HandoverHub(sessionId, (event) => this.emit(event));
    this.hubs.set(sessionId, hub);
    return hub;
  }

  /** Drop a session's hub (the session is gone). */
  forget(sessionId: string): void {
    this.hubs.delete(sessionId);
  }

  /** The sessions that have a hub (the shutdown sweep). */
  sessionIds(): Iterable<string> {
    return this.hubs.keys();
  }
}
