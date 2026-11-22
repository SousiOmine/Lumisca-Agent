/**
 * Event emission: the one channel an agent reports on.
 *
 * A subscriber is a client bridge (the session agent's event hub), so a
 * listener that throws must never take the loop with it. Kept out of agent.ts
 * because it is the only thing here that both the run and the modules beside
 * it write to.
 */

import type { AgentMessage } from "../domain/message.ts";
import type { AgentEvent } from "./agent-types.ts";

export class AgentEvents {
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  /** Subscribe to agent events; returns an unsubscribe function. */
  subscribe(fn: (event: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event: AgentEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // event sinks must never break the loop
      }
    }
  }

  /** Announce a message the agent appended to the transcript (the session
   * agent announces the prompt-side messages it builds). Only `message_end`
   * is emitted: nothing streams for these messages, and the client upserts
   * the finished message on that event — a message_start would only send the
   * same payload twice (tool results can carry images). */
  announce(message: AgentMessage): void {
    this.emit({ type: "message_end", message });
  }
}
