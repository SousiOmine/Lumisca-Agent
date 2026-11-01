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
  /** The loaded window of the conversation, oldest first (a long
   * conversation is read one window at a time; see the core's
   * session/transcript-window.ts). */
  entries: StellaEntry[];
  /** The cursor for the entries before `entries[0]`, or null at the
   * conversation's beginning. */
  older: string | null;
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
    streamingText: "",
    running: snapshot.running,
    questions: snapshot.questions,
    handover: snapshot.handover,
    ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
    agentName: snapshot.agentName,
  };
}

/**
 * Merge the newest window of a conversation into the entries a client holds.
 *
 * Entries are ordered by the transcript, so the window's entries anchor on the
 * ones with the same identity and anything the client lacks goes in front of
 * the anchor it precedes; anything after the last anchor is the conversation's
 * newest and extends the end. A window that shares nothing replaces the
 * entries (the client fell behind by more than a page), and a window that
 * changes nothing returns what was passed in (`replaced: false`).
 */
function mergeEntries(
  existing: StellaEntry[],
  fetched: StellaEntry[],
): { entries: StellaEntry[]; replaced: boolean } {
  if (fetched.length === 0) return { entries: existing, replaced: false };
  if (existing.length === 0) return { entries: fetched, replaced: false };
  const indexByKey = new Map(
    existing.map((entry, index) => [entryKey(entry), index] as const),
  );
  if (!fetched.some((entry) => indexByKey.has(entryKey(entry)))) {
    return { entries: fetched, replaced: true };
  }

  const merged: StellaEntry[] = [];
  let pending: StellaEntry[] = [];
  let cursor = 0;
  for (const entry of fetched) {
    const anchor = indexByKey.get(entryKey(entry));
    if (anchor === undefined) {
      pending.push(entry);
      continue;
    }
    while (cursor < anchor) {
      merged.push(existing[cursor]!);
      cursor++;
    }
    // The same identity is the same entry: the persisted copy wins.
    merged.push(...pending, entry);
    pending = [];
    cursor = anchor + 1;
  }
  while (cursor < existing.length) {
    merged.push(existing[cursor]!);
    cursor++;
  }
  merged.push(...pending);
  return { entries: merged, replaced: false };
}

/**
 * Put a page the reader asked for (the entries before `older`) in front of
 * what the client holds.
 *
 * The page is asked for by cursor, but the cursor names a point in a
 * conversation that keeps growing: by the time the answer arrives, a run may
 * have appended entries AFTER the cursor. Those are not this page's to
 * insert. Prepending everything the client lacks put a live reply at the TOP
 * of the conversation — and because the next live event then appended the
 * same entry again, the conversation showed the message twice (a duplicate
 * that a reload removed, since the server holds it once).
 *
 * So only entries that belong before what the client holds are taken: the
 * page stops at the first entry the client already has, and an entry newer
 * than the client's newest is left to the live stream. A page that adds
 * nothing ends the walk — the client must not be sent round the same window
 * twice.
 */
export function prependOlderEntries(
  state: StellaConversationState,
  fetched: StellaEntry[],
  nextOlder: string | null,
): StellaConversationState {
  if (fetched.length === 0) return { ...state, older: null };
  const known = new Set(state.entries.map(entryKey));
  const newest = state.entries.at(-1)?.timestamp ?? 0;
  const added: StellaEntry[] = [];
  for (const entry of fetched) {
    // The page has run into what the client holds: everything after this is
    // history the client already has, not the page before it.
    if (known.has(entryKey(entry))) break;
    // An entry the client does not hold but that is newer than its newest
    // belongs to the live edge, not above it.
    if (entry.timestamp > newest) break;
    added.push(entry);
  }
  if (added.length === 0) return { ...state, older: null };
  return { ...state, entries: [...added, ...state.entries], older: nextOlder };
}

/** Identity of an entry for dedup.
 *
 * An entry arrives more than once — the synthetic start/end pair an injected
 * message emits, and the streaming placeholder followed by the final copy of
 * the same message — so the client has to recognise "the same entry". Role,
 * timestamp and the attachments' names are NOT enough: the clock is a
 * millisecond, and two sends inside one millisecond (a burst of Enter, or a
 * server that stamps a batch with one tick) are two different messages that
 * must not collapse into one. The text is what tells them apart, so it is the
 * last component of the key.
 *
 * The one case that must still collide is the pair above: the same message
 * announced twice carries the same text. A message that is republished after
 * an edit would arrive as a new entry, which is the honest reading — the
 * transcript has no edit concept. */
export function entryKey(entry: StellaEntry): string {
  const files = entry.attachments.map((file) => file.name).join(",");
  const images = entry.images.length;
  return `${entry.role}:${entry.timestamp}:${files}:${images}:${entry.text}`;
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
    older: null,
    streamingText: "",
    running: false,
    questions: [],
    handover: null,
    agentName,
  };
}
