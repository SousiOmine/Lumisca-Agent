import {
  type MergeRules,
  mergeWindow,
  prependHistoricWindow as prependHistoric,
} from "./events.ts";
import type {
  StellaConversationSnapshot,
  StellaEntry,
  StellaEvent,
  StellaHandover,
  StellaQuestion,
  ThinkingLevel,
} from "./types.ts";

/**
 * One stella conversation's state, and the reducer that advances it.
 *
 * Deliberately not `SessionView`: that type carries what a code-mode tab
 * needs (tool timers, todo/task/background panels, rewind tombstones for a
 * session list that stella does not have). A conversation is entries and what
 * is blocking the run — so this store holds exactly that, and its reducer can
 * be read in one sitting.
 *
 * There is no streaming text. A message arrives whole when its turn ends —
 * the agent's final text, or what it sent with `send_chat` — so there is no
 * half-written reply to hold. The run's presence is `running` alone (the
 * transcript draws its typing dots from it).
 *
 * The reducer is pure so the event handling can be tested without a socket,
 * a browser or a server: the hook that owns the connection only calls
 * `applyStellaEvent`.
 */

export interface StellaConversationState {
  /** The loaded window of the conversation, oldest first (a long
   * conversation is read one window at a time; see the core's
   * session/transcript-window.ts). */
  entries: StellaEntry[];
  /** The cursor for the entries before `entries[0]`, or null at the
   * conversation's beginning. */
  older: string | null;
  running: boolean;
  /** The card a `send_chat` call is writing right now, as far as it has
   * arrived, or null. The run has no streaming TEXT (a reply arrives whole),
   * but a card is presentation: drawing it while it is written reads as
   * progress. The finished entry carries the whole card and clears this. */
  liveCard: { toolCallId: string; markup: string } | null;
  questions: StellaQuestion[];
  handover: StellaHandover | null;
  error?: string;
  /** The agent's name: the conversation's title. */
  agentName: string;
  /** The model the conversation runs on (the session row's choice), shown in
   * the composer's model line. Null before the first snapshot arrives. */
  model: { provider: string; modelId: string } | null;
  /** The thinking strength the conversation's model runs at, and the levels
   * it supports. Read from the model's own settings row: it is not the
   * conversation's state, and a change made in the settings panel applies
   * here too. Null before the first snapshot arrives. */
  thinking: {
    level: ThinkingLevel;
    levels: ThinkingLevel[];
  } | null;
}

/**
 * The state of a conversation just read from the server, merged into what the
 * client already holds.
 *
 * The snapshot is a WINDOW of the conversation (see the core's
 * session/transcript-window.ts), and it is read again after every WS drop and
 * revision gap. The entries are merged by identity rather than replaced: a
 * reader who paged back through older windows keeps them, and the window that
 * just arrived adds what the socket never delivered. A window that shares
 * nothing with the state means the client is not at the conversation's end any
 * more; it is taken as the state, cursor included.
 */
export function stellaStateOf(
  snapshot: StellaConversationSnapshot,
  current?: StellaConversationState,
): StellaConversationState {
  const merged = current === undefined
    ? { entries: snapshot.entries, replaced: true }
    : mergeEntries(current.entries, snapshot.entries);
  return {
    entries: merged.entries,
    // The client keeps the cursor of the oldest entry it loaded unless the
    // whole window replaced it: a window that starts inside what it holds
    // must not lose the reader's way back.
    older: merged.replaced ? snapshot.older : current!.older,
    running: snapshot.running,
    // A snapshot is the finished conversation; a card being written belongs
    // to the run that is still going, and a reconnect picks the rest up from
    // the events that follow.
    liveCard: null,
    questions: snapshot.questions,
    handover: snapshot.handover,
    ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
    agentName: snapshot.agentName,
    model: snapshot.model,
    thinking: {
      level: snapshot.thinkingLevel ?? "off",
      levels: snapshot.thinkingLevels ?? [],
    },
  };
}

/**
 * Merge the newest window of a conversation into the entries a client holds.
 * The rule is the one both transcripts share (events/merge.ts): entries are
 * ordered by the transcript, so the window anchors on the ones with the same
 * identity and anything the client lacks goes in front of the anchor it
 * precedes; anything after the last anchor extends the end. A window that
 * shares nothing replaces the entries (the client fell behind by more than a
 * page), and a window that changes nothing returns what was passed in.
 *
 * What differs from a code-mode session is only the identity: a conversation
 * entry is identified by what it says (see entryKey), and a key is unique by
 * construction, so one position per key is matched.
 */
function mergeEntries(
  existing: StellaEntry[],
  fetched: StellaEntry[],
): { entries: StellaEntry[]; replaced: boolean } {
  if (fetched.length === 0) return { entries: existing, replaced: false };
  if (existing.length === 0) return { entries: fetched, replaced: false };
  const merged = mergeWindow(
    { items: existing, older: null },
    { items: fetched, older: null },
    ENTRY_RULES,
  );
  return { entries: merged.items, replaced: merged.items === fetched };
}

/** How the merge identifies one conversation entry. */
const ENTRY_RULES: MergeRules<StellaEntry> = {
  key: (entry) => entryKey(entry),
};

/**
 * Put a page the reader asked for (the entries before `older`) in front of
 * what the client holds.
 *
 * The page is asked for by cursor, but the cursor names a point in a
 * conversation that keeps growing: by the time the answer arrives, a run may
 * have appended entries AFTER the cursor. Those are not this page's to insert
 * (see events/merge.ts: the rule stated once for both transcripts).
 */
export function prependOlderEntries(
  state: StellaConversationState,
  fetched: StellaEntry[],
  nextOlder: string | null,
): StellaConversationState {
  const merged = prependHistoric(
    { items: state.entries, older: state.older },
    fetched,
    nextOlder,
    { key: (entry) => entryKey(entry), timestamp: (entry) => entry.timestamp },
  );
  return { ...state, entries: merged.items, older: merged.older };
}

/** Identity of an entry for dedup.
 *
 * An entry arrives more than once — the synthetic start/end pair an injected
 * message emits, and the prompt's placeholder followed by the finished copy —
 * so the client has to recognise "the same entry". Role, timestamp and the
 * attachments' names are NOT enough: the clock is a millisecond, and two
 * sends inside one millisecond (a burst of Enter, an agent that called
 * send_chat twice in one turn) are two different messages that must not
 * collapse into one. The text is what tells them apart, so it is the last
 * component of the key.
 *
 * The one case that must still collide is the pair above: the same message
 * announced twice carries the same text. A message that is republished after
 * an edit would arrive as a new entry, which is the honest reading — the
 * transcript has no edit concept. */
export function entryKey(entry: StellaEntry): string {
  const attachments = entry.attachments.map((file) => file.name).join(",");
  // A prompt's own files are part of its identity: an image-only prompt and
  // an empty prompt of the same millisecond would otherwise be one entry.
  const files = entry.files.map((file) => file.ref).join(",");
  // Two prompts of one millisecond that say the same words differ when one
  // of them came from a routine: the name is part of the identity.
  return `${entry.role}:${entry.timestamp}:${attachments}:${files}:${
    entry.card ?? ""
  }:${entry.routine ?? ""}:${entry.text}`;
}

/** Insert or replace an entry at its existing position (dedup by key), or
 * append it. The position is kept so a later copy of the same message cannot
 * reorder the conversation. */
function upsertEntry(
  entries: StellaEntry[],
  entry: StellaEntry,
): StellaEntry[] {
  const key = entryKey(entry);
  const index = entries.findIndex((e) => entryKey(e) === key);
  if (index === -1) return [...entries, entry];
  if (entries[index] === entry) return entries;
  const next = [...entries];
  next[index] = entry;
  return next;
}

/** The conversation's next state for one event. Returns `null` when nothing
 * changed (the caller then keeps the previous object, so a memoized view does
 * not re-render for a no-op). */
export function applyStellaEvent(
  state: StellaConversationState,
  event: StellaEvent,
): StellaConversationState | null {
  switch (event.type) {
    case "agent_start":
      return state.running && state.error === undefined &&
          state.liveCard === null
        ? null
        : { ...state, running: true, error: undefined, liveCard: null };
    case "agent_end":
      return !state.running && state.liveCard === null
        ? null
        : { ...state, running: false, liveCard: null };
    case "card_delta": {
      const markup = state.liveCard?.toolCallId === event.toolCallId
        ? state.liveCard.markup + event.delta
        : event.delta;
      return {
        ...state,
        liveCard: { toolCallId: event.toolCallId, markup },
      };
    }
    case "entry": {
      const entries = upsertEntry(state.entries, event.entry);
      // A message arrives whole, so an unchanged list means nothing to
      // re-render — unless a card was being drawn, which the finished entry
      // now replaces.
      return entries === state.entries && state.liveCard === null
        ? null
        : { ...state, entries, liveCard: null };
    }
    case "questions":
      return sameQuestions(event.questions, state.questions) ? null : {
        ...state,
        questions: event.questions,
      };
    case "handover":
      return sameHandover(event.handover, state.handover) ? null : {
        ...state,
        handover: event.handover,
      };
    case "error":
      return { ...state, error: event.message, liveCard: null };
  }
}

/** Equality for a question list: a `question` event replaces the whole list
 * for the run (stella asks one at a time), so identity of the tool call plus
 * the questions' ids is enough to tell "the same ask" from a new one. */
function sameQuestions(
  a: readonly StellaQuestion[],
  b: readonly StellaQuestion[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((q, index) => {
    const other = b[index];
    return other !== undefined &&
      q.toolCallId === other.toolCallId &&
      q.questions.length === other.questions.length &&
      q.questions.every((question, i) =>
        question.id === other.questions[i]?.id
      );
  });
}

function sameHandover(
  a: StellaHandover | null,
  b: StellaHandover | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.toolCallId === b.toolCallId && a.reason === b.reason &&
    a.instructions === b.instructions && a.expiresAt === b.expiresAt;
}

/** An empty conversation (the sidebar can be shown before one is open). The
 * model, and with it the thinking strength, is unknown until a snapshot
 * arrives; the picker stays hidden while it is `null`. */
export function emptyStellaState(agentName: string): StellaConversationState {
  return {
    entries: [],
    older: null,
    running: false,
    liveCard: null,
    questions: [],
    handover: null,
    agentName,
    model: null,
    thinking: null,
  };
}
