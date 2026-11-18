/**
 * Recognising a reduced row: a message the transcript pruning replaced with
 * a marker (see session/prune.ts).
 *
 * The predicate lives beside the message types it reads, not with the
 * pruning policy: the LLM view has to skip those rows, and a policy module
 * importing the view's dependencies would point the dependency the wrong way.
 */
import type { AgentMessage } from "./types.ts";

/** How a marker is recognised without a schema column: every one starts
 * with this token. */
export const PRUNED_MARKER = "[pruned]";

/** Whether a text block is one of the pruning markers. */
export function isPrunedText(text: string): boolean {
  return text.startsWith(PRUNED_MARKER);
}

/** Whether a message was already reduced. */
export function isPruned(message: AgentMessage): boolean {
  switch (message.role) {
    case "assistant":
      // A reduced turn holds no calls (they became one text marker).
      return (
        !message.content.some((block) => block.type === "toolCall") &&
        message.content.some(
          (block) => block.type === "text" && isPrunedText(block.text),
        )
      );
    case "toolResult":
      return (
        message.content.length > 0 &&
        message.content.every(
          (block) => block.type === "text" && isPrunedText(block.text),
        )
      );
    case "context":
    case "notification":
      return isPrunedText(message.body);
    default:
      return false;
  }
}
