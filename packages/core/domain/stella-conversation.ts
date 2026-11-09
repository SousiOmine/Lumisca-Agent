/**
 * What a client of a stella conversation receives.
 *
 * A stella conversation is a chat with a counterpart: the user's words and
 * the agent's replies (the final text of a turn, and what `send_chat` sent
 * with it), nothing about how the work was done. The model's history is a
 * different thing — it also carries the agent's narration, context
 * publications, tool calls and results, notifications and compaction
 * checkpoints — so the two are separate types on separate endpoints
 * (`/api/stella/conversations/:agentId`), instead of one transcript that
 * every viewer filters for itself.
 *
 * The split is what keeps the mode's promise (a conversation, not a work
 * log) from depending on a client remembering to hide rows. A client that
 * never receives a `Date: …` publication cannot show it — and one that never
 * receives a turn's narration cannot leak it into a conversation the agent
 * was not addressing.
 */
import type { AskTurn } from "../shared/interaction.ts";
import type { AttachmentRef, PromptFileRef } from "../shared/attachments.ts";
import type { ThinkingLevel } from "../shared/providers.ts";

/** One thing the user or the agent said, as the conversation shows it.
 *
 * **An agent's entry is a reply: the text of its final turn, and what
 * `send_chat` sent alongside it (the words, the card, the files).** A model
 * asked anything has to produce text, and a turn that ends without a tool
 * call is that answer — the default, so a forgotten `send_chat` cannot leave
 * the user waiting. A turn that stopped to call a tool is narration, not an
 * entry, and neither is the silence sentinel (`NO_RESPONSE`); see
 * agent/stella-stream.ts. */
export interface StellaEntry {
  /** `user` is the person talking; `assistant` is the agent. There is no
   * other role in a conversation (stella has no modes, no notifications). */
  role: "user" | "assistant";
  /** The message's text ("" for a message that only sent a card or a set of
   * files). */
  text: string;
  /** The card the message showed (the `card` argument of `send_chat`), or
   * null. A card is the message's presentation — a table, a flow chart, a
   * question — so it travels with the words rather than being dropped with
   * the tool call that carried it. One call carries one card; a client that
   * received two would be drawing a message the agent never sent. */
  card: string | null;
  /** Files the agent sent with `send_chat`, in the order it named them.
   * Like a card, the files ARE part of the message (something to look at or
   * keep), so they travel with it while the tool call itself stays in the
   * model's history. Empty for a message that sent none. */
  attachments: AttachmentRef[];
  /** Files and pictures the user attached to the prompt (a drop or a
   * paste). They are the message's content, so they are drawn inside the
   * bubble at the point the user sent them. The bytes live in the machine,
   * not here: a client asks for one by `ref` (see the prompt-upload route)
   * and draws what comes back, or says the file is gone when the machine no
   * longer has it. Empty for the agent's entries. */
  files: PromptFileRef[];
  /** The routine whose run asked this (its name), when the user did not
   * type the message. Its text is the routine's standing instruction — the
   * request the agent wrote down when the routine was created — so a client
   * must NOT draw the entry as the user's words: a request they scheduled is
   * not a sentence they wrote. The name still travels — it is part of the
   * entry's identity, and it is what the agent list's second line says.
   * Absent for everything they typed. */
  routine?: string;
  /** Epoch ms, from the message itself: rewind names a message by it. */
  timestamp: number;
}

/** A pending ask (the `ask` tool): the questions the run is blocked on. */
export type StellaQuestion = AskTurn;

/** The screen hand-over the run waits on (`vm_ask_user`). */
export interface StellaHandover {
  toolCallId: string;
  reason: string;
  instructions: string | null;
  /** When the wait ends on its own (epoch ms). The pane says when, so a
   * user who returns late knows the run resumed without them. */
  expiresAt: number;
}

/** Everything a client needs to draw a conversation from nothing: the
 * messages, whether a run is going right now, and what is blocking it.
 * Read in one handler so the pieces describe the same instant. */
export interface StellaConversationSnapshot {
  entries: StellaEntry[];
  /** The cursor for the window before these entries, or null at the
   * conversation's beginning. A conversation is served one window at a time
   * (see core's session/transcript-window.ts): a long one must not be sent
   * whole on every reconnect, so a client reads further only when the reader
   * scrolls up. */
  older: string | null;
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
  /** The model this conversation runs on, so the composer's model line shows
   * it and can switch it (POST `…/model`). The session row is the source of
   * truth; reading it here keeps a reopened conversation honest even when the
   * app default has changed since. */
  model: { provider: string; modelId: string };
  /** The thinking level the conversation's model runs at, and the levels it
   * supports. The composer's model line shows a strength control beside the
   * model when there is more than one level, the same as code mode's: a
   * stella conversation is where a long, multi-step request is most likely
   * to need one.
   *
   * The level belongs to the MODEL (the settings store keys it by provider
   * and model), so this is not the conversation's state — it is what the
   * model's row says right now, read through the session's model. */
  thinkingLevel?: ThinkingLevel;
  thinkingLevels?: ThinkingLevel[];
  /** The conversation's revision at the moment of this snapshot, so a
   * later `GET …/revision` can tell whether anything was missed. */
  rev: number;
}

/** The event stream of one conversation. Deliberately small: there is no
 * tool, todo, task, background or goal event, because the conversation has
 * none of those surfaces. A `null` result from the projection means the
 * model-only event ends here.
 *
 * There is no streaming event for TEXT. A message arrives whole when its turn
 * ends: the agent's final text is the reply, so there is nothing to watch
 * being written — the run shows itself with the typing indicator until the
 * answer is finished.
 *
 * A card is the exception: it is presentation rather than words, so it is
 * drawn while the model writes it (a long table appearing row by row reads as
 * progress, not as a half-sentence). The finished `entry` carries the whole
 * card and replaces what was drawn from the fragments. */
export type StellaEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  /** One finished message (a prompt, or what the agent sent). */
  | { type: "entry"; entry: StellaEntry }
  /** A fragment of a card being written into a `send_chat` call: the markup
   * appended since the previous fragment of that call. */
  | { type: "card_delta"; toolCallId: string; delta: string }
  /** The pending questions changed (asked, answered, or dropped). */
  | { type: "questions"; questions: StellaQuestion[] }
  /** The screen hand-over began or ended (`null`). */
  | { type: "handover"; handover: StellaHandover | null }
  | { type: "error"; message: string };
