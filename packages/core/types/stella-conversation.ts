/**
 * What a client of a stella conversation receives.
 *
 * A stella conversation is a chat with a counterpart: the user's words and
 * the agent's words, nothing about how the work was done. The model's
 * history is a different thing — it carries context publications, tool
 * calls and results, notifications and compaction checkpoints, and no
 * client reads it — so the two are separate types on separate endpoints
 * (`/api/stella/conversations/:agentId`), instead of one transcript that
 * every viewer filters for itself.
 *
 * The split is what keeps the mode's promise (a conversation, not a work
 * log) from depending on a client remembering to hide rows. A client that
 * never receives a `Date: …` publication cannot show it.
 */
import type { AskQuestion } from "../shared/interaction.ts";
import type { AttachmentRef } from "../shared/attachments.ts";

/** One thing the user or the agent said, as the conversation shows it.
 * `text` and `cards` are one entry rather than two because they are one
 * message: the agent's reply and the card it showed belong to the same
 * turn, and splitting them would let a client order them wrongly. */
export interface StellaEntry {
  /** `user` is the person talking; `assistant` is the agent. There is no
   * other role in a conversation (stella has no modes, no notifications). */
  role: "user" | "assistant";
  /** The message's text ("" for an assistant message that only shows a
   * card or a set of files). */
  text: string;
  /** `chat_ui` markup the message showed, in order. A card is the reply's
   * presentation — a table, a flow chart, a question — so it travels with
   * the words rather than being dropped with the tool call that carried
   * it. */
  cards: string[];
  /** Files the agent sent with `chat_attach`, in the order it sent them.
   * Like a card, the files ARE part of the reply (something to look at or
   * keep), so they travel with it while the tool call itself stays in the
   * model's history. Empty for a message that sent none. */
  attachments: AttachmentRef[];
  /** Epoch ms, from the message itself: rewind names a message by it. */
  timestamp: number;
}

/** A pending ask (the `ask` tool): the questions the run is blocked on. */
export interface StellaQuestion {
  toolCallId: string;
  questions: AskQuestion[];
}

/** The screen hand-over the run waits on (`vm_ask_user`). */
export interface StellaHandover {
  toolCallId: string;
  reason: string;
  instructions: string | null;
}

/** Everything a client needs to draw a conversation from nothing: the
 * messages, whether a run is going right now, and what is blocking it.
 * Read in one handler so the pieces describe the same instant. */
export interface StellaConversationSnapshot {
  entries: StellaEntry[];
  /** A run is active (its `agent_start` is never replayed). */
  running: boolean;
  /** Questions awaiting the user's answers; empty when none. */
  questions: StellaQuestion[];
  /** The screen hand-over the run is blocked on, or null. */
  handover: StellaHandover | null;
  /** The last run's failure, cleared when a new run starts. */
  error?: string;
  /** The agent's name: the conversation's title. */
  agentName: string;
  /** Where the conversation's published images live (`visual:` references).
   * The client addresses the conversation by agent, so this id is the one
   * thing it learns about the session — objects, not addressing. */
  sessionId: string;
  /** The conversation's revision at the moment of this snapshot, so a
   * later `GET …/revision` can tell whether anything was missed. */
  rev: number;
}

/** The event stream of one conversation. Deliberately small: there is no
 * tool, todo, task, background or goal event, because the conversation has
 * none of those surfaces. A `null` result from the projection means the
 * model-only event ends here. */
export type StellaEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  /** One finished message (a prompt, a reply, a card). */
  | { type: "entry"; entry: StellaEntry }
  /** A piece of the reply that is still streaming. */
  | { type: "delta"; delta: string }
  /** The pending questions changed (asked, answered, or dropped). */
  | { type: "questions"; questions: StellaQuestion[] }
  /** The screen hand-over began or ended (`null`). */
  | { type: "handover"; handover: StellaHandover | null }
  | { type: "error"; message: string };
