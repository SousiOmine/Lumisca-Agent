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
 * The rule they share: **the conversation is the user's words and what the
 * agent SENT with `send_chat`.** Everything else stays in the model's history
 * and out of the conversation:
 *
 * - the agent's own text. A model asked anything has to write something; that
 *   text is its working notes — how it thinks out loud, what it just ran,
 *   what it is about to do. Showing it made every turn a paragraph whether or
 *   not there was anything to say, and a routine that found nothing still
 *   reported that it had found nothing. So the text is not part of the
 *   conversation, and a turn that sends nothing leaves the screen as it was.
 * - everything that exists to steer the model — the date, the skill catalog,
 *   the identity, the on-demand-tools note (all `context` messages);
 * - everything that records HOW the work went — tool calls, tool results,
 *   notifications, compaction checkpoints.
 *
 * A `send_chat` RESULT is therefore the one tool result that becomes an
 * entry: it carries the words, the card and the files the agent chose to
 * send (in its `details`; see shared/chat-message.ts). Nothing else does —
 * `chat_attach` and `chat_ui` used to, and a conversation that predates
 * `send_chat` therefore keeps only its user's side. That is deliberate: the
 * old rows are the record of a rule that no longer exists, and a projection
 * that still honoured them would keep two ways of deciding what a
 * conversation shows.
 *
 * There is no streaming either. The agent's text is not shown, so there is
 * nothing to watch being written; a message arrives whole, when the tool
 * returns.
 */
import type { AgentMessage } from "../ai/types.ts";
import { chatMessageOfDetails } from "../shared/chat-message.ts";
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
 * An assistant message is ALWAYS model-only: its text is the agent's working
 * notes, and what the user reads is the `send_chat` call it made, which
 * arrives as that call's result (below).
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
    case "assistant":
      // Its text is the model's working notes, not the conversation's (see
      // the module comment). What it sent arrives as the tool result below.
      return null;
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
 * `message_delta` is model-only by design, not by oversight: the agent's text
 * never reaches the conversation, so a delta has nothing to add to it. The
 * transport keeps forwarding deltas for code mode; this projection drops
 * them.
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
