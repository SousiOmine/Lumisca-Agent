import type { AgentMessage, SessionView } from "../types.ts";
import { isViewRunning } from "../types.ts";
import {
  type LoadedWindow,
  mergeNewestWindow as mergeWindow,
  prependOlderWindow as prependWindow,
} from "./merge.ts";

/** Identity key for dedup: messages are keyed by role + timestamp (the
 * same pair used by the persisted rows), with one extra field for the two
 * roles whose millisecond is not unique:
 *
 * - a tool result is keyed by its tool call id (a turn's parallel calls can
 *   finish within the same millisecond, and a shared timestamp would make
 *   the live upsert replace one of them and the resync merge skip it for
 *   good — a message is never re-added once its key is known);
 * - a context snapshot by its provider (the dynamic contexts are published
 *   in one loop and share the millisecond; without this two of them look
 *   like one message, the resync merge re-anchors on the wrong index and the
 *   row is inserted again on every sync).
 *
 * The minimal shape also accepts the entries carried by the
 * messages_truncated event, which name the same fields. */
export function messageKey(m: {
  role: string;
  timestamp: number;
  toolCallId?: unknown;
  provider?: unknown;
}): string {
  if (m.role === "toolResult" && typeof m.toolCallId === "string") {
    return `${m.role}:${m.toolCallId}`;
  }
  if (m.role === "context" && typeof m.provider === "string") {
    return `${m.role}:${m.provider}:${m.timestamp}`;
  }
  return `${m.role}:${m.timestamp}`;
}

/** Drop messages whose key is in the `removed` set (rewind tombstones).
 * Merging never deletes, so without this a resync would resurrect messages a
 * rewind deleted while the socket was down. */
export function filterRemoved(
  messages: AgentMessage[],
  removed: Set<string>,
): AgentMessage[] {
  if (removed.size === 0) return messages;
  return messages.filter((m) => !removed.has(messageKey(m)));
}

/** A view's loaded history plus the cursor for the window before it. */
export interface LoadedHistory {
  messages: AgentMessage[];
  /** The cursor for the window before `messages[0]`, or null at the
   * transcript's beginning (see SessionSnapshot). */
  older: string | null;
}

/** Fold the NEWEST window the server returned into the history a view
 * holds (see merge.ts for the rule both transcripts share). What this
 * wrapper adds is what is specific to a code-mode session: messages are
 * keyed with `messageKey`, and a duplicated identity is matched per
 * occurrence (a corrupted history can hold the same key twice). */
export function mergeNewestWindow(
  history: LoadedHistory,
  window: LoadedHistory,
  removed: Set<string>,
): LoadedHistory {
  return fromWindow(
    mergeWindow(toWindow(history), toWindow(window), {
      key: (message) => messageKey(message),
      multiAnchor: true,
    }),
    removed,
  );
}

/** Put the page the reader asked for in front of the history (see
 * merge.ts). Loading a page never deletes, so the rewind tombstones stay:
 * the caller passes an empty set and the page is taken as it arrives. */
export function prependOlderWindow(
  history: LoadedHistory,
  fetched: AgentMessage[],
  nextOlder: string | null,
): LoadedHistory {
  return fromWindow(
    prependWindow(toWindow(history), fetched, nextOlder, {
      key: (message) => messageKey(message),
    }),
    new Set(),
  );
}

/** The view's shape as the shared merge sees it. `LoadedHistory` and
 * `LoadedWindow` are the same two fields; these two builders keep the merge
 * module free of this package's types. */
function toWindow(history: LoadedHistory): LoadedWindow<AgentMessage> {
  return { items: history.messages, older: history.older };
}

/** The merge's answer back in the view's shape, minus the rewind tombstones.
 * Merging never deletes, so without this a resync would resurrect messages a
 * rewind removed while the socket was down. */
function fromWindow(
  window: LoadedWindow<AgentMessage>,
  removed: Set<string>,
): LoadedHistory {
  return {
    messages: filterRemoved(window.items, removed),
    older: window.older,
  };
}

/** Reconcile a view's run state with the transcript snapshot's `running`
 * flag (`GET /sessions/:id/messages`; see api-local's SessionSnapshot).
 * The events are the live source of the run state, but they are never
 * replayed: a view that (re)connects while a run is going — a page load, a
 * WS drop, a tab reopened on this session — never saw its `agent_start`,
 * and without this the live run would render as finished (work log
 * collapsed under 作業完了). The server reads the flag with the transcript,
 * so the two always describe the same instant.
 *
 * Only a disagreement writes: a view that already agrees keeps its
 * identity (the periodic sync must not re-render every tab) and a finished
 * run keeps the end time its `agent_end` stamped. */
export function applyRunState(
  view: SessionView,
  running: boolean,
): SessionView {
  if (running === isViewRunning(view)) return view;
  if (!running) {
    // The run ended while this view was not listening. Its `agent_end` is
    // not replayed, so drop the stale run state: the transcript's own
    // timestamps carry the finished run's duration (see
    // ChatView/ConversationTurn).
    return {
      ...view,
      agentStartedAt: undefined,
      agentEndedAt: undefined,
    };
  }
  // A run is active and this view never saw it start. `agentStartedAt` is
  // a flag for the UI (every displayed timer is derived from the
  // transcript's messages), so the moment this view learned about the run
  // is the honest value.
  return {
    ...view,
    agentStartedAt: Date.now(),
    agentEndedAt: undefined,
  };
}
