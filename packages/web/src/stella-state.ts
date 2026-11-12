import { sameAsks } from "@lumisca/core/shared";
import {
  type MergeRules,
  mergeWindow,
  prependHistoricWindow as prependHistoric,
} from "./events.ts";
import type {
  FolderShare,
  StellaConversationSnapshot,
  StellaEntry,
  StellaEnvRequest,
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
  /** The card being written into the reply right now, as far as it has
   * arrived, or null. The run has no streaming TEXT (a reply arrives whole),
   * but a card is presentation: drawing it while it is written reads as
   * progress. The finished entry carries the whole card and clears this;
   * `card_end` clears it when the message turns out to be narration. */
  liveCard: { toolCallId: string; markup: string } | null;
  questions: StellaQuestion[];
  handover: StellaHandover | null;
  /** The environment variable the run waits for the user to fill in, or
   * null. Carries the name only — a value never reaches the client. */
  envRequest: StellaEnvRequest | null;
  /** The folders the user lent this conversation from their own computer.
   * A security fact, not progress: the view shows it for as long as it
   * lasts, and the whole list travels on every change. */
  shares: FolderShare[];
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
  const merged =
    current === undefined
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
    envRequest: snapshot.envRequest,
    shares: snapshot.shares,
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
  const cards = entry.segments
    .filter((segment) => segment.type === "card")
    .map((segment) => segment.markup)
    .join(",");
  return `${entry.role}:${entry.timestamp}:${attachments}:${files}:${cards}:${
    entry.routine ?? ""
  }:${entry.text}`;
}

/** The entries a conversation draws, in order: every entry but a routine's
 * prompt.
 *
 * A routine's run is delivered as the user's prompt, but its text is the
 * instruction the agent wrote down when the routine was created — a standing
 * order, not a sentence the user typed. Drawing it in the reader's own bubble
 * credits them with a request they never made, so the transcript skips the
 * entry and shows only what the run answered. The entry stays in the state:
 * it is the identity of that run (see entryKey) and it is what the agent
 * list's second line names, so it must keep arriving.
 *
 * The caller must derive the transcript from this list rather than skipping
 * rows while rendering: the day separators, the avatar runs and the scroll
 * anchor all read "the entry before this one", and a skipped row would leave
 * a separator with nothing under it or an anchor that is not in the document. */
export function transcriptEntries(
  entries: readonly StellaEntry[],
): StellaEntry[] {
  return entries.filter((entry) => entry.routine === undefined);
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
      return state.running &&
        state.error === undefined &&
        state.liveCard === null
        ? null
        : { ...state, running: true, error: undefined, liveCard: null };
    case "agent_end":
      return !state.running && state.liveCard === null
        ? null
        : { ...state, running: false, liveCard: null };
    case "card_delta": {
      const markup =
        state.liveCard?.toolCallId === event.toolCallId
          ? state.liveCard.markup + event.delta
          : event.delta;
      return {
        ...state,
        liveCard: { toolCallId: event.toolCallId, markup },
      };
    }
    case "card_end":
      return state.liveCard === null ? null : { ...state, liveCard: null };
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
      return sameAsks(event.questions, state.questions)
        ? null
        : {
            ...state,
            questions: event.questions,
          };
    case "handover":
      return sameHandover(event.handover, state.handover)
        ? null
        : {
            ...state,
            handover: event.handover,
          };
    case "env_request":
      return sameEnvRequest(event.request, state.envRequest)
        ? null
        : {
            ...state,
            envRequest: event.request,
          };
    case "shares":
      return sameShares(event.shares, state.shares)
        ? null
        : { ...state, shares: event.shares };
    case "error":
      return { ...state, error: event.message, liveCard: null };
  }
}

function sameHandover(
  a: StellaHandover | null,
  b: StellaHandover | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.toolCallId === b.toolCallId &&
    a.reason === b.reason &&
    a.instructions === b.instructions &&
    a.expiresAt === b.expiresAt
  );
}

function sameEnvRequest(
  a: StellaEnvRequest | null,
  b: StellaEnvRequest | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.toolCallId === b.toolCallId &&
    a.name === b.name &&
    a.exists === b.exists &&
    a.expiresAt === b.expiresAt
  );
}

/** Whether two loan lists say the same thing. Every field is compared: a
 * folder re-lent with narrower terms (writing taken away, the shell closed) is
 * a different fact even though the folder is the same one. */
function sameShares(
  a: readonly FolderShare[],
  b: readonly FolderShare[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((share, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      share.id === other.id &&
      share.name === other.name &&
      share.write === other.write &&
      share.exec === other.exec &&
      share.expiresAt === other.expiresAt &&
      share.host.platform === other.host.platform &&
      share.host.shell === other.host.shell
    );
  });
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
    envRequest: null,
    shares: [],
    agentName,
    model: null,
    thinking: null,
  };
}
