import type { AgentEvent, AgentMessage } from "../ai/types.ts";
import { ToolArgsField } from "../ai/tool-args-field.ts";
import type { ClientEvent } from "../domain/event.ts";
import { TOOL_CHAT_ATTACH, TOOL_SEND_CHAT } from "../shared/mod.ts";

/**
 * The incremental readers of the two tools that carry a card, keyed by tool
 * call. A card is drawn while the model writes its arguments, so the text has
 * to be cut out of the call's JSON as it streams; the finished message
 * replaces whatever a client drew.
 */
export class CardStreams {
  private readonly streams = new Map<string, ToolArgsField>();

  /** Feed a fragment of a call's arguments; the card text that became
   * readable, or null. */
  push(toolCallId: string, delta: string): string | null {
    let reader = this.streams.get(toolCallId);
    if (reader === undefined) {
      reader = new ToolArgsField("card");
      this.streams.set(toolCallId, reader);
    }
    return reader.push(delta);
  }

  /** Forget a call (it started running, so its arguments are complete). */
  forget(toolCallId: string): void {
    this.streams.delete(toolCallId);
  }
}

/** What one agent event means to the session outside the agent loop. */
export interface TranslatedRunEvent {
  /** Events to publish, in order. */
  events: ClientEvent[];
  /** The rows the store must write now (a message just ended). */
  persist?: boolean;
  /** An assistant message the user should see an error for, if it is one. */
  modelError?: AgentMessage;
  /** A completed exchange for the retry policy to judge. */
  turnEnded?: AgentMessage;
}

/**
 * One agent event as the client events it becomes, plus the policy facts the
 * session has to act on.
 *
 * The translation is pure except for the card reader (a fold over the
 * argument deltas of one call); everything that touches the transcript, the
 * retry state or the timers is the caller's. Keeping the switch pure is what
 * makes "what does the stream say" readable without reading the run policy.
 */
export function translateRunEvent(
  event: AgentEvent,
  sessionId: string,
  cards: CardStreams,
): TranslatedRunEvent {
  switch (event.type) {
    case "agent_start":
      return { events: [{ type: "agent_start", sessionId }] };
    case "message_start":
      return {
        events: [{ type: "message_start", sessionId, message: event.message }],
      };
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type !== "text_delta") return { events: [] };
      return {
        events: [{ type: "message_delta", sessionId, delta: update.delta }],
      };
    }
    case "message_end":
      return {
        events: [{ type: "message_end", sessionId, message: event.message }],
        persist: true,
        modelError: event.message,
      };
    case "tool_input_delta": {
      if (
        event.toolName !== TOOL_SEND_CHAT &&
        event.toolName !== TOOL_CHAT_ATTACH
      ) {
        return { events: [] };
      }
      const piece = cards.push(event.toolCallId, event.delta);
      return piece === null ? { events: [] } : {
        events: [{
          type: "card_delta",
          sessionId,
          toolCallId: event.toolCallId,
          delta: piece,
        }],
      };
    }
    case "tool_execution_start":
      cards.forget(event.toolCallId);
      return {
        events: [{
          type: "tool_start",
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        }],
      };
    case "tool_execution_end":
      cards.forget(event.toolCallId);
      return {
        events: [{
          type: "tool_end",
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        }],
      };
    case "turn_end":
      return { events: [], turnEnded: event.message };
    case "agent_end":
      return { events: [{ type: "agent_end", sessionId }] };
  }
}
