/**
 * The projection from a stella session to its conversation.
 *
 * Both directions live here, so the snapshot and the event stream cannot
 * disagree about what a client sees:
 *
 * - {@link stellaEntriesOf} turns one transcript message into the
 *   conversation entries a client draws (none when the message is
 *   model-only);
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
import type { AgentMessage, ToolResultMessage } from "../ai/message.ts";

import type { ClientEvent, MessageIdentity } from "../domain/event.ts";
import type {
  StellaEntry,
  StellaEntryIdentity,
  StellaEnvRequest,
  StellaEvent,
  StellaHandover,
  StellaQuestion,
  StellaShareRequest,
} from "../domain/stella-conversation.ts";
import {
  type ChatMessage,
  chatMessageOfDetails,
} from "../shared/chat-message.ts";
import { segmentsText, splitChatText } from "../shared/chat-ui/segments.ts";
import type { UiSegment } from "../shared/chat-ui/types.ts";
import { TOOL_EXECUTE, TOOL_SEND_CHAT } from "../shared/tool-names.ts";
import { assistantTextVerdict } from "./silent-reply.ts";

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
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

/**
 * The conversation entries one transcript message projects to, oldest first:
 * none, one, or — for a program that spoke — several.
 *
 * Plural because one row can carry more than one message: under the
 * scripting tool call a stella agent speaks by calling `send_chat` from
 * inside `execute` (see tools/execute.ts), and the program's result is the
 * only row the store keeps of it. What it sent travels in that row's
 * `details.sent`, in the order it was sent, so one program can be a progress
 * note followed by the answer. Drawing them as one bubble would claim they
 * were one message.
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
export function stellaEntriesOf(message: AgentMessage): StellaEntry[] {
  switch (message.role) {
    case "user":
    case "mode": {
      const text =
        message.role === "mode" ? message.shortText : textOf(message);
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
      //
      // stella's setup turn is that case with a purpose (see
      // stella/onboarding.ts): the app writes the instruction, the model
      // reads it through `modelContent`, and the conversation shows only the
      // agent's greeting and the questions it chose.
      const files = message.role === "mode" ? [] : (message.files ?? []);
      if (text.length === 0 && files.length === 0) return [];
      // A routine's run is delivered as a prompt, so it sits on the user's
      // side — but it is not something the user said, and a client does not
      // draw it. The name travels with the entry anyway: it is how the run is
      // told apart from the same words typed (see entryKey) and what the agent
      // list's second line shows (see StellaEntry.routine).
      const routine = message.role === "mode" ? undefined : message.routine;
      return [
        {
          role: "user",
          text,
          segments: text.length === 0 ? [] : [{ type: "text", text }],
          attachments: [],
          files,
          ...(routine === undefined ? {} : { routine }),
          timestamp: message.timestamp,
        },
      ];
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
      if (message.stopReason === "toolUse") return [];
      const verdict = assistantTextVerdict(textOf(message));
      if (verdict.kind !== "message") return [];
      // The reply is read, not echoed: a card is a block written into it
      // (see shared/chat-ui/segments.ts), so the words and the cards are
      // separated here once, and every reader below gets the same picture.
      const segments = splitChatText(verdict.text);
      if (segments.length === 0) return [];
      return [
        {
          role: "assistant",
          text: segmentsText(segments),
          segments,
          attachments: [],
          files: [],
          timestamp: message.timestamp,
        },
      ];
    }
    case "toolResult": {
      // Only what the agent SENT is the conversation's; every other tool
      // result is the model's record of its work.
      if (message.isError) return [];
      if (message.toolName === TOOL_SEND_CHAT) {
        return entriesOfSent(
          chatMessageOfDetails(message.details),
          message.timestamp,
        );
      }
      // A program that spoke: the messages it sent are carried by its own
      // result (see tools/execute.ts).
      if (message.toolName === TOOL_EXECUTE) return sentEntriesOf(message);
      return [];
    }
    // Notifications, context publications and compaction checkpoints are
    // the model's, not the conversation's.
    default:
      return [];
  }
}

/** The entries one sent message makes, or none when it carried nothing.
 *
 * The tool refuses an empty message, so an empty one is a row this build did
 * not write: an empty bubble would claim the agent said something. */
function entriesOfSent(
  sent: ChatMessage | undefined,
  timestamp: number,
): StellaEntry[] {
  if (sent === undefined) return [];
  const segments: UiSegment[] = splitChatText(sent.text);
  if (segments.length === 0 && sent.attachments.length === 0) return [];
  return [
    {
      role: "assistant",
      text: segmentsText(segments),
      segments,
      attachments: sent.attachments,
      files: [],
      timestamp,
    },
  ];
}

/** The messages a program sent with `send_chat`, as the entries they are.
 *
 * They keep the program's order and share its result's timestamp: one
 * program is one step, and the order inside it is the order it sent. Two
 * messages of one step are still told apart — the client's identity includes
 * what each said (see web's entryKey) — so a note and the answer that
 * follows it do not collapse into one. */
function sentEntriesOf(message: ToolResultMessage): StellaEntry[] {
  const details = message.details as { sent?: unknown } | undefined;
  const sent = details?.sent;
  if (!Array.isArray(sent)) return [];
  const entries: StellaEntry[] = [];
  for (const item of sent) {
    entries.push(
      ...entriesOfSent(chatMessageOfDetails(item), message.timestamp),
    );
  }
  return entries;
}

/** The cursor naming one conversation entry (see readWindow): the fields a
 * client tells two entries apart by — the role and the timestamp the message
 * carries, plus what the message carried, because an agent that sends two
 * messages in the same millisecond (two `send_chat` calls in one turn) would
 * otherwise have them collapse into one. Opaque to clients, which only echo
 * it. */
/** The conversation entries a set of stored rows projects to, oldest
 * first: one projection shared by the window reader, the conversation
 * endpoints and `history_search`. A row with no visible entry (a tool
 * result, a context message) is skipped. */
export function conversationEntriesOf(
  messages: readonly AgentMessage[],
): StellaEntry[] {
  const entries: StellaEntry[] = [];
  for (const message of messages) entries.push(...stellaEntriesOf(message));
  return entries;
}

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
    // attachments differ only in what they said: the start of each card (a
    // card can be long, and its beginning is what tells two apart) and the
    // start of the text name which is which.
    entry.segments
      .filter((segment) => segment.type === "app")
      .map((segment) => segment.json.slice(0, 64))
      .join(""),
    entry.text.slice(0, 64),
    // A routine's prompt and the same words typed by the user are different
    // messages: the name is part of what tells them apart.
    entry.routine ?? "",
  ]);
}

/** The entries a rewind removed, as the conversation names them.
 *
 * This reads {@link stellaEntriesOf}'s mapping backwards: `user` and `mode` are
 * drawn as the user's entry, `assistant` and a tool result as the agent's, and
 * every other role — a context publication, a notification, a compaction
 * checkpoint — is not drawn at all, so naming it would only widen what a
 * client drops.
 *
 * A `toolResult` is included whether or not it was `send_chat`: the identity
 * carries no tool name, and a `send_chat` entry sits at its result's own
 * timestamp (see stellaEntriesOf) — leaving the role out would keep every
 * message the agent sent from a rewound run on the screen. */
function removedEntriesOf(
  removed: readonly MessageIdentity[],
): StellaEntryIdentity[] {
  const entries = new Map<string, StellaEntryIdentity>();
  for (const message of removed) {
    const role =
      message.role === "user" || message.role === "mode"
        ? "user"
        : message.role === "assistant" || message.role === "toolResult"
          ? "assistant"
          : null;
    if (role === null) continue;
    entries.set(`${role}:${message.timestamp}`, {
      role,
      timestamp: message.timestamp,
    });
  }
  return [...entries.values()];
}

/** The conversation's view of a pending-question list. The shapes are the
 * same today; the named type keeps the conversation's contract from drifting
 * with the ask hub's. */
function questionsOf(questions: readonly StellaQuestion[]): StellaQuestion[] {
  return questions.map((q) => ({
    toolCallId: q.toolCallId,
    questions: q.questions,
  }));
}

/** The conversation's view of a hand-over (same reason as questionsOf). */
function handoverOf(handover: StellaHandover | null): StellaHandover | null {
  return handover === null
    ? null
    : {
        toolCallId: handover.toolCallId,
        reason: handover.reason,
        instructions: handover.instructions,
        expiresAt: handover.expiresAt,
      };
}

/** The conversation's view of a folder request (same reason as
 * questionsOf): the fields the card and the shell call need, and nothing
 * else. */
function shareRequestOf(
  event: Extract<ClientEvent, { type: "share_request" }>,
): StellaShareRequest {
  return event.kind === "lend"
    ? {
        kind: "lend",
        toolCallId: event.toolCallId,
        reason: event.reason,
        expiresAt: event.expiresAt,
      }
    : {
        kind: "disconnect",
        toolCallId: event.toolCallId,
        id: event.id,
        name: event.name,
        expiresAt: event.expiresAt,
      };
}

/** The conversation's view of an environment-variable request (same reason
 * as questionsOf). There is no value to copy: none ever arrives as an
 * event. */
function envRequestOf(
  request: StellaEnvRequest | null,
): StellaEnvRequest | null {
  return request === null
    ? null
    : {
        toolCallId: request.toolCallId,
        name: request.name,
        exists: request.exists,
        expiresAt: request.expiresAt,
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
      return [
        {
          type: "agent_end",
          ...(event.silent === true ? { silent: true } : {}),
        },
      ];
    case "message_start":
    case "message_end": {
      const entries = stellaEntriesOf(event.message);
      // Both events carry the same message (a synthetic start/end pair for
      // an injected message, or the prompt and the finished copy of what an
      // agent sent). Sending the entries twice is harmless — clients upsert
      // by role + timestamp — and keeping both means a client that missed the
      // start still gets the message.
      return entries.map((entry) => ({ type: "entry", entry }));
    }
    case "question":
      return [
        {
          type: "questions",
          questions: questionsOf([
            {
              toolCallId: event.toolCallId,
              questions: event.questions,
            },
          ]),
        },
      ];
    case "handover":
      return [
        {
          type: "handover",
          handover: handoverOf({
            toolCallId: event.toolCallId,
            reason: event.reason,
            instructions: event.instructions,
            expiresAt: event.expiresAt,
          }),
        },
      ];
    case "handover_end":
      return [{ type: "handover", handover: null }];
    case "env_request":
      return [
        {
          type: "env_request",
          request: envRequestOf({
            toolCallId: event.toolCallId,
            name: event.name,
            exists: event.exists,
            expiresAt: event.expiresAt,
          }),
        },
      ];
    case "env_request_end":
      return [{ type: "env_request", request: null }];
    case "share_request":
      return [{ type: "share_request", request: shareRequestOf(event) }];
    case "share_request_end":
      return [{ type: "share_request", request: null }];
    case "shares":
      return [{ type: "shares", shares: event.shares }];
    case "ui_delta":
      // An app card being written into the reply. The conversation has no
      // streaming TEXT (a reply arrives whole), but a card is drawn while the
      // model writes it: it is presentation, not words, so there is no
      // half-sentence to guard against.
      return [
        {
          type: "ui_delta",
          toolCallId: event.toolCallId,
          delta: event.delta,
        },
      ];
    case "ui_end":
      return [{ type: "ui_end" }];
    case "messages_truncated":
      // A rewind is the one way an entry LEAVES a conversation, and no
      // snapshot can carry it: a client merges the newest window into what it
      // holds, and merging only adds (see the web's stellaStateOf). Without
      // this event the deleted turn stays on screen until the conversation is
      // reopened.
      return [{ type: "truncated", removed: removedEntriesOf(event.removed) }];
    case "session_error":
      return [{ type: "error", message: event.message }];
    default:
      return [];
  }
}
