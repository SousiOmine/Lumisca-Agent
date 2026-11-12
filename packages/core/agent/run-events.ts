import type { AgentEvent, AgentMessage } from "../ai/types.ts";
import type { ClientEvent } from "../domain/event.ts";
import { splitChatText } from "../shared/ui-markup/segments.ts";

/**
 * The card being written into the reply, read out of the text as it streams.
 *
 * A card is a fenced block in the model's own text (ui-markup/segments.ts).
 * Code mode's client receives that text and cuts the card out where it draws;
 * a stella conversation never receives the text (its reply arrives whole), so
 * the card has to be taken out here, to be drawn while it is written.
 *
 * `push` answers only with the part that became readable since the previous
 * fragment: a client appends what a `card_delta` gives it.
 */
export class TextCards {
  /** The message's text so far (one message; `reset` starts the next). */
  private text = "";
  /** The id of the card being written; "" when the text ends outside one. */
  private id = "";
  /** How much of that card the client already has. */
  private emitted = "";
  /** Whether the fence that opened is a card's and is still open. */
  private open = false;
  /** Whether anything was drawn since the message began. */
  private drawn = false;
  private seq = 0;

  /** Feed one text delta; the card text that became readable, or null. */
  push(delta: string): { id: string; delta: string } | null {
    const beforeLine = this.text.slice(this.text.lastIndexOf("\n") + 1);
    this.text += delta;
    // A card fence opens with a line of backticks or tildes, so ordinary
    // prose is never scanned. The info string can arrive in a later delta
    // (` ```ca ` then `rd `), so a line that had begun with a marker still
    // needs the scan after the delta that completes it.
    const mayOpen = /^ {0,3}(`{3,}|~{3,})/.test(beforeLine);
    if (
      !this.open &&
      !delta.includes("`") &&
      !delta.includes("~") &&
      !mayOpen
    ) {
      return null;
    }
    const segments = splitChatText(this.text);
    const last = segments.at(-1);
    if (last?.type !== "card") {
      // The fence closed (or was not a card's): nothing is being written.
      this.open = false;
      this.id = "";
      this.emitted = "";
      return null;
    }
    if (!this.open || !last.markup.startsWith(this.emitted)) {
      // A new card: a fresh id makes the client start over instead of
      // appending to the one it has.
      this.id = `text-${++this.seq}`;
      this.emitted = "";
      this.open = true;
    }
    const piece = last.markup.slice(this.emitted.length);
    this.emitted = last.markup;
    this.drawn = true;
    return piece.length === 0 ? null : { id: this.id, delta: piece };
  }

  /** Start a new message. */
  reset(): void {
    this.text = "";
    this.id = "";
    this.emitted = "";
    this.open = false;
    this.drawn = false;
  }

  /** The message ended: forget it (its entry, when it has one, carries the
   * whole card). Returns whether a card was drawn, so the caller can tell a
   * client to drop it when the message turns out to be narration. */
  end(): boolean {
    const drawn = this.drawn;
    this.reset();
    return drawn;
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
 * The translation is pure except for the card reader (the text of one
 * message, folded as it arrives); everything that touches the transcript,
 * the retry state or the timers is the caller's. Keeping the switch pure is
 * what makes "what does the stream say" readable without reading the run
 * policy.
 */
export function translateRunEvent(
  event: AgentEvent,
  sessionId: string,
  /** The reader of the card being written into the reply, or undefined when
   * the client receives the text itself and cuts the card out where it draws
   * (code mode). */
  textCards: TextCards | undefined,
  /** What the run has said so far (see RunReply): carried by `agent_end` so
   * a notification can show an answer instead of just "finished". */
  reply?: string,
  /** Whether this end belongs to a routine run that said nothing and is
   * removed from the conversation (see RoutineRun): nothing to open the app
   * for, so the end is not notified. */
  silent?: boolean,
): TranslatedRunEvent {
  switch (event.type) {
    case "agent_start":
      return { events: [{ type: "agent_start", sessionId }] };
    case "message_start":
      if (event.message.role === "assistant") textCards?.reset();
      return {
        events: [{ type: "message_start", sessionId, message: event.message }],
      };
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type !== "text_delta") return { events: [] };
      const events: ClientEvent[] = [
        {
          type: "message_delta",
          sessionId,
          delta: update.delta,
        },
      ];
      const piece = textCards?.push(update.delta) ?? null;
      if (piece !== null) {
        events.push({
          type: "card_delta",
          sessionId,
          toolCallId: piece.id,
          delta: piece.delta,
        });
      }
      return { events };
    }
    case "message_end": {
      const events: ClientEvent[] = [
        {
          type: "message_end",
          sessionId,
          message: event.message,
        },
      ];
      // A message that was narration ends here without becoming one (see
      // agent/stella-stream.ts): the card it drew has nowhere to land.
      if (event.message.role === "assistant" && textCards?.end() === true) {
        events.push({ type: "card_end", sessionId });
      }
      return { events, persist: true, modelError: event.message };
    }
    case "tool_execution_start":
      return {
        events: [
          {
            type: "tool_start",
            sessionId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          },
        ],
      };
    case "tool_execution_end":
      return {
        events: [
          {
            type: "tool_end",
            sessionId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          },
        ],
      };
    case "turn_end":
      return { events: [], turnEnded: event.message };
    case "agent_end":
      return {
        events: [
          {
            type: "agent_end",
            sessionId,
            ...(reply === undefined || reply.length === 0 ? {} : { reply }),
            ...(silent === true ? { silent: true } : {}),
          },
        ],
      };
  }
}
