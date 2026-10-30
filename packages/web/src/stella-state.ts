import type {
  StellaConversationSnapshot,
  StellaEntry,
  StellaEvent,
  StellaHandover,
  StellaQuestion,
} from "./types.ts";

/**
 * One stella conversation's state, and the reducer that advances it.
 *
 * Deliberately not `SessionView`: that type carries what a code-mode tab
 * needs (tool timers, todo/task/background panels, rewind tombstones for a
 * session list that stella does not have). A conversation is entries, a
 * stream of text, and what is blocking the run — so this store holds exactly
 * that, and its reducer can be read in one sitting.
 *
 * The reducer is pure so the event handling can be tested without a socket,
 * a browser or a server: the hook that owns the connection only calls
 * `applyStellaEvent`.
 */

export interface StellaConversationState {
  /** The messages, in transcript order. */
  entries: StellaEntry[];
  /** The reply that is still arriving. Appended to the last entry when the
   * run ends (see the `entry` case), never kept alongside a finished one. */
  streamingText: string;
  running: boolean;
  questions: StellaQuestion[];
  handover: StellaHandover | null;
  error?: string;
  /** The agent's name: the conversation's title. */
  agentName: string;
}

/** The state of a conversation just read from the server. */
export function stellaStateOf(
  snapshot: StellaConversationSnapshot,
): StellaConversationState {
  return {
    entries: snapshot.entries,
    streamingText: "",
    running: snapshot.running,
    questions: snapshot.questions,
    handover: snapshot.handover,
    ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
    agentName: snapshot.agentName,
  };
}

/** Identity of an entry for dedup: an entry arrives twice (the synthetic
 * start/end pair of an injected message, and the streaming placeholder
 * followed by the final copy), and a re-read snapshot can overlap the live
 * events. Role + timestamp is the same pair the server persists. */
export function entryKey(entry: StellaEntry): string {
  return `${entry.role}:${entry.timestamp}`;
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
      return state.running && state.error === undefined ? null : {
        ...state,
        running: true,
        error: undefined,
      };
    case "agent_end":
      return state.running
        ? { ...state, running: false, streamingText: "" }
        : null;
    case "entry": {
      const entries = upsertEntry(state.entries, event.entry);
      // A finished entry replaces whatever was streaming: the server sends
      // the complete message, so the text that accumulated from deltas is
      // now redundant (and might be a prefix of it).
      const changed = entries !== state.entries || state.streamingText !== "";
      return changed ? { ...state, entries, streamingText: "" } : null;
    }
    case "delta":
      return { ...state, streamingText: state.streamingText + event.delta };
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
      return { ...state, error: event.message };
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
    a.instructions === b.instructions;
}

/** An empty conversation (the sidebar can be shown before one is open). */
export function emptyStellaState(agentName: string): StellaConversationState {
  return {
    entries: [],
    streamingText: "",
    running: false,
    questions: [],
    handover: null,
    agentName,
  };
}
