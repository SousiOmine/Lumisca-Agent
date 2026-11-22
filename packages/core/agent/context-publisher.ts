/**
 * Dynamic context providers and the transcript messages they publish.
 *
 * Providers (the skill catalog, the workspace instructions) each hold a
 * value the model should see, and publish it only when it changed. The two
 * hard parts live here:
 *
 * - publishing happens before a request, and each update becomes an ordinary
 *   transcript message (announced to clients like any injected message);
 * - a reopened or compacted session must not republish what the model has
 *   already seen, so the publisher re-anchors to the newest checkpoint and
 *   forgets a publication that fell outside the model's view.
 */

import { contextStart } from "../ai/context-compaction.ts";
import type { ContextProvider } from "../ai/context-providers.ts";
import { contextMessage } from "../ai/context-providers.ts";
import type { AgentMessage, ContextMessage } from "../domain/message.ts";

/** What publishing needs from the session that owns it. */
export interface ContextSink {
  append(message: AgentMessage): void;
  announce(message: AgentMessage): void;
  nextTimestamp(): number;
  isClosed(): boolean;
}

export class ContextPublisher {
  constructor(
    private readonly providers: readonly ContextProvider[],
    private readonly sink: ContextSink,
  ) {}

  /** Re-anchor every provider to the part of the transcript the model
   * actually sees (from the newest checkpoint on). A publication that a
   * compaction left outside the model's view is forgotten, so the provider
   * publishes its current value again before the next request. */
  rebase(messages: readonly AgentMessage[]): void {
    if (this.providers.length === 0) return;
    const last = new Map<string, unknown>();
    for (let i = contextStart(messages); i < messages.length; i++) {
      const message = messages[i]!;
      if (message.role === "context") last.set(message.provider, message.state);
    }
    for (const provider of this.providers) {
      provider.rebase(last.get(provider.name));
    }
  }

  /** Publish the pending updates as transcript messages, before a run
   * starts, so the model sees the current value in its first request. */
  publish(): void {
    if (this.sink.isClosed()) return;
    for (const provider of this.providers) {
      for (const update of provider.next()) {
        const message: ContextMessage = contextMessage(
          provider.name,
          update,
          this.sink.nextTimestamp(),
        );
        this.sink.append(message);
        this.sink.announce(message);
      }
    }
  }
}
