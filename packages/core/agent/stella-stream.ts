/**
 * The projection from a stella session to its conversation.
 *
 * Both directions live here, so the snapshot and the event stream cannot
 * disagree about what a client sees:
 *
 * - {@link stellaEntryOf} turns one transcript message into the conversation
 *   entry a client draws (or `null` when the message is model-only);
 * - {@link stellaEventsOf} turns one `ClientEvent` into the conversation
 *   events it implies (or none).
 *
 * The rule they share: a conversation is the user's words and the agent's
 * words. Everything that exists to steer the model — the date, the skill
 * catalog, the identity, the on-demand-tools note (all `context` messages) —
 * and everything that records HOW the work went — tool calls, tool results,
 * notifications, compaction checkpoints — stays in the model's history and
 * out of the conversation. A `chat_ui` card is the one tool call that is
 * also a reply, so it travels with the text that carried it.
 */
import type { AgentMessage } from "../ai/types.ts";
import { TOOL_CHAT_ATTACH, TOOL_CHAT_UI } from "../shared/tool-names.ts";
import { attachmentsOfDetails } from "../shared/attachments.ts";
import type { ClientEvent } from "../types/event.ts";
import type {
  StellaEntry,
  StellaEvent,
  StellaHandover,
  StellaQuestion,
} from "../types/stella-conversation.ts";

/** A message that carries content blocks: the three conversational roles. */
type ContentMessage = Extract<
  AgentMessage,
  { role: "user" | "assistant" | "toolResult" }
>;

/** The text blocks of a message, joined (the message text a client shows). */
function textOf(message: ContentMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .filter((block): block is { type: "text"; text: string } =>
      block.type === "text"
    )
    .map((block) => block.text)
    .join("");
}

/** The `chat_ui` markups a message carried, in order. A call without a
 * string `markup` is not a card (the tool would have rejected it); it is
 * skipped rather than rendered as a broken card. */
function cardsOf(message: ContentMessage): string[] {
  const content = message.content;
  if (typeof content === "string") return [];
  const cards: string[] = [];
  for (const block of content) {
    if (block.type !== "toolCall" || block.name !== TOOL_CHAT_UI) continue;
    const args = block.arguments as { markup?: unknown } | undefined;
    if (typeof args?.markup === "string") cards.push(args.markup);
  }
  return cards;
}

/**
 * The conversation entry for one transcript message, or `null` when the
 * message is part of the model's history only.
 *
 * `user` and `mode` are the person talking (stella has no slash commands, so
 * `mode` never occurs; it is accepted because the projection is written
 * against the transcript's actual type). An assistant message appears when it
 * says something: text, a card, or the files it sent. A message that exists
 * only to carry a tool call would be an empty row, so it is left out.
 *
 * A `chat_attach` result is the one tool result that becomes an entry of its
 * own: the files an agent hands over are part of the reply (something to
 * look at or keep), not a record of how it worked. It is kept as a separate
 * entry rather than merged into the preceding message because the two are
 * separate messages in the transcript — merging would make the projection
 * depend on what came before it, and an event replayed out of order (or a
 * reload that starts mid-conversation) would put the files in the wrong
 * place.
 */
export function stellaEntryOf(message: AgentMessage): StellaEntry | null {
  switch (message.role) {
    case "user":
    case "mode": {
      const text = message.role === "mode"
        ? message.shortText
        : textOf(message);
      return text.length === 0 ? null : {
        role: "user",
        text,
        cards: [],
        attachments: [],
        timestamp: message.timestamp,
      };
    }
    case "assistant": {
      const text = textOf(message);
      const cards = cardsOf(message);
      if (text.length === 0 && cards.length === 0) return null;
      return {
        role: "assistant",
        text,
        cards,
        attachments: [],
        timestamp: message.timestamp,
      };
    }
    case "toolResult": {
      // Only the files an agent sent are the conversation's; every other
      // tool result is the model's record of its work.
      if (message.toolName !== TOOL_CHAT_ATTACH || message.isError) return null;
      const attachments = attachmentsOfDetails(message.details);
      return attachments.length === 0 ? null : {
        role: "assistant",
        text: "",
        cards: [],
        attachments,
        timestamp: message.timestamp,
      };
    }
    // Notifications, context publications and compaction checkpoints are
    // the model's, not the conversation's.
    default:
      return null;
  }
}

/** The attachment list a `chat_attach` result carries, or none when the
 * details are not the shape this build wrote (see shared/attachments.ts). */
/** The conversation's view of a pending-question list. The shapes are the
 * same today; the named type keeps the conversation's contract from drifting
 * with the ask hub's. */
function questionsOf(
  questions: readonly StellaQuestion[],
): StellaQuestion[] {
  return questions.map((q) => ({
    toolCallId: q.toolCallId,
    questions: q.questions,
  }));
}

/** The conversation's view of a hand-over (same reason as questionsOf). */
function handoverOf(handover: StellaHandover | null): StellaHandover | null {
  return handover === null ? null : {
    toolCallId: handover.toolCallId,
    reason: handover.reason,
    instructions: handover.instructions,
  };
}

/**
 * The conversation events one `ClientEvent` implies; empty when the event is
 * model-only (tools, todo, tasks, background commands, goals, checkpoints,
 * federation) or belongs to the transcript the conversation does not show.
 *
 * The event's `sessionId` is dropped: a conversation stream is bound to one
 * conversation, so carrying the id would only invite clients to route it.
 */
export function stellaEventsOf(event: ClientEvent): StellaEvent[] {
  switch (event.type) {
    case "agent_start":
      return [{ type: "agent_start" }];
    case "agent_end":
      return [{ type: "agent_end" }];
    case "message_start":
    case "message_end": {
      const entry = stellaEntryOf(event.message);
      // Both events carry the same message (a synthetic start/end pair for
      // an injected message, or the placeholder and the final copy of a
      // reply). Sending the entry twice is harmless — clients upsert by
      // role + timestamp — and keeping both means a client that missed the
      // start still gets the message.
      return entry === null ? [] : [{ type: "entry", entry }];
    }
    case "message_delta":
      return [{ type: "delta", delta: event.delta }];
    case "question":
      return [{
        type: "questions",
        questions: questionsOf([{
          toolCallId: event.toolCallId,
          questions: event.questions,
        }]),
      }];
    case "handover":
      return [{
        type: "handover",
        handover: handoverOf({
          toolCallId: event.toolCallId,
          reason: event.reason,
          instructions: event.instructions,
        }),
      }];
    case "handover_end":
      return [{ type: "handover", handover: null }];
    case "session_error":
      return [{ type: "error", message: event.message }];
    default:
      return [];
  }
}
