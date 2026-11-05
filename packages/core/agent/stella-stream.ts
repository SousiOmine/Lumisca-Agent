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
 * The rule they share: **the conversation is the user's messages and the
 * agent's replies.** A reply is the assistant message's text; `send_chat`
 * adds what the agent sends alongside it (cards, files, progress messages).
 * Everything else stays in the model's history and out of the conversation:
 *
 * - tool calls and their results, except the `send_chat` result that carries
 *   what the agent sent;
 * - everything that exists to steer the model — the date, the skill catalog,
 *   the identity, the on-demand-tools note (all `context` messages);
 * - everything that records HOW the work went — notifications and compaction
 *   checkpoints.
 *
 * The assistant's text is the reply because the model cannot be relied on to
 * remember to call a tool: an agent that forgot `send_chat` left the user
 * waiting for an answer that never came. The prompt asks for `NO_RESPONSE`
 * when a turn should say nothing (see silent-reply.ts), so silence is
 * explicit rather than the default failure.
 *
 * A `send_chat` RESULT is therefore not merged into the assistant message
 * that called it: the two are separate messages in the transcript, and
 * merging would make the projection depend on what came before it (an event
 * replayed out of order, or a reload that starts mid-conversation, would put
 * the message in the wrong place).
 */
import type { AgentMessage } from "../ai/types.ts";
import { chatMessageOfDetails } from "../shared/chat-message.ts";
import { assistantTextVerdict } from "./silent-reply.ts";
import { TOOL_SEND_CHAT } from "../shared/tool-names.ts";
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

/**
 * The conversation entry for one transcript message, or `null` when the
 * message is part of the model's history only.
 *
 * `user` and `mode` are the person talking (stella has no slash commands, so
 * `mode` never occurs; it is accepted because the projection is written
 * against the transcript's actual type).
 *
 * An assistant message is the agent's reply: its text is what the user
 * reads, unless the turn wrote only the silence sentinel (silent-reply.ts).
 *
 * A `send_chat` result is kept as its own entry rather than merged into the
 * assistant message that called it, because the two are separate messages in
 * the transcript — merging would make the projection depend on what came
 * before it, and an event replayed out of order (or a reload that starts
 * mid-conversation) would put the message in the wrong place.
 */
export function stellaEntryOf(message: AgentMessage): StellaEntry | null {
  switch (message.role) {
    case "user":
    case "mode": {
      const text = message.role === "mode"
        ? message.shortText
        : textOf(message);
      // A message is worth showing when it says something OR brings
      // something: a prompt that was a screenshot alone is a real message,
      // and dropping it would leave a reply with nothing it answered.
      //
      // A prompt with neither is NOT shown, and that is a decision rather
      // than an oversight: a message whose visible text is empty and that
      // attached no file has nothing to draw, and an empty bubble is worse
      // than no bubble. The model may still have been sent one — that is
      // what UserMessage.modelContent is for — and the run it started is
      // real. What such a prompt must never become is a way to put words in
      // the transcript: anything worth the user's attention is a file, a
      // picture, or text they can see.
      const files = message.role === "mode" ? [] : message.files ?? [];
      if (text.length === 0 && files.length === 0) return null;
      return {
        role: "user",
        text,
        card: null,
        attachments: [],
        files,
        timestamp: message.timestamp,
      };
    }
    case "assistant": {
      // Only the FINAL text of a run is the conversation's message. A message
      // that ends in a tool call is the agent narrating its way to the next
      // step ("checking the file", "now the tests") — it is the model
      // thinking out loud with a tool attached, and a run that runs ten tools
      // writes ten of these. Showing them buried the answer under its own
      // working notes.
      //
      // The distinction is structural, not stylistic: `stopReason` is the
      // provider's own word for why the turn ended, so "the model stopped
      // talking to use a tool" needs no guessing at the text. A run that says
      // nothing but narrates and then calls `send_chat` still reaches the user
      // — that is what the tool is for — and a run that ends without either
      // is caught by the sentinel rule below.
      if (message.stopReason === "toolUse") return null;
      const verdict = assistantTextVerdict(textOf(message));
      if (verdict.kind !== "message") return null;
      return {
        role: "assistant",
        text: verdict.text,
        card: null,
        attachments: [],
        files: [],
        timestamp: message.timestamp,
      };
    }
    case "toolResult": {
      // Only what the agent SENT is the conversation's; every other tool
      // result is the model's record of its work.
      if (message.toolName !== TOOL_SEND_CHAT || message.isError) return null;
      const sent = chatMessageOfDetails(message.details);
      if (sent === undefined) return null;
      if (
        sent.text.length === 0 && sent.card === null &&
        sent.attachments.length === 0
      ) {
        // The tool refuses an empty message, so this is a row this build did
        // not write: an empty bubble would claim the agent said something.
        return null;
      }
      return {
        role: "assistant",
        text: sent.text,
        card: sent.card,
        attachments: sent.attachments,
        files: [],
        timestamp: message.timestamp,
      };
    }
    // Notifications, context publications and compaction checkpoints are
    // the model's, not the conversation's.
    default:
      return null;
  }
}

/** The cursor naming one conversation entry (see readWindow): the fields a
 * client tells two entries apart by — the role and the timestamp the message
 * carries, plus what the message carried, because an agent that sends two
 * messages in the same millisecond (two `send_chat` calls in one turn) would
 * otherwise have them collapse into one. Opaque to clients, which only echo
 * it. */
export function stellaEntryCursorOf(entry: StellaEntry): string {
  return JSON.stringify([
    entry.role,
    entry.timestamp,
    entry.attachments[0]?.name ?? "",
    // A prompt that carried files and a message that sent some in the same
    // millisecond would otherwise collapse into one cursor; the first file's
    // reference names which prompt it was.
    entry.files[0]?.ref ?? "",
    // Two messages of one millisecond that carried neither files nor
    // attachments differ only in what they said: the card (whole, it is
    // short) and the start of the text name which is which.
    entry.card ?? "",
    entry.text.slice(0, 64),
  ]);
}

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
 * model-only (text deltas, tools, todo, tasks, background commands, goals,
 * checkpoints, federation) or belongs to the transcript the conversation does
 * not show.
 *
 * `message_delta` is model-only by design, not by oversight: a turn's text
 * arrives whole when the turn ends (its final text is the reply), so a delta
 * has nothing to add to the conversation — it would only show half-written
 * words that may never be sent. The transport keeps forwarding deltas for
 * code mode; this projection drops them.
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
      // an injected message, or the prompt and the finished copy of what an
      // agent sent). Sending the entry twice is harmless — clients upsert by
      // role + timestamp — and keeping both means a client that missed the
      // start still gets the message.
      return entry === null ? [] : [{ type: "entry", entry }];
    }
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
