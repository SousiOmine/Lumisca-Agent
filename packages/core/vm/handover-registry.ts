import type { ClientEvent } from "../domain/event.ts";
import { HubRegistry } from "../interruptions/hub-registry.ts";
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
  private readonly hubs: HubRegistry<HandoverHub>;

  /** `emit` publishes the hub's events to every frontend listener. */
  constructor(emit: (event: ClientEvent) => void) {
    this.hubs = new HubRegistry(
      (sessionId) => new HandoverHub(sessionId, emit),
    );
  }

  for(sessionId: string): HandoverHub {
    return this.hubs.for(sessionId);
  }

  forget(sessionId: string): void {
    this.hubs.forget(sessionId);
  }

  sessionIds(): Iterable<string> {
    return this.hubs.sessionIds();
  }
}
