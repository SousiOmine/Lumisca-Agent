import type { AgentMessage } from "../ai/types.ts";
import { CoreError } from "../errors.ts";
import type { MessageIdentity } from "../types/event.ts";

/**
 * Reading a transcript one window at a time.
 *
 * A session's transcript is the model's whole history and grows without
 * bound, but a client draws only what fits on its screen and reads back no
 * further than the reader scrolls. Sending all of it on every (re)connect,
 * tab restore and page load is what made a long conversation slow to open and
 * slow to keep in sync, so the snapshot endpoints serve one window and hand
 * back a cursor for the next older one (Terasuma's API has the same shape).
 *
 * Two rules live here.
 *
 * **The cursor is an identity, not a position.** It names the oldest item a
 * client holds (role + timestamp, plus the tool call id for a tool result),
 * and the server resolves it against the live transcript. Positions would
 * have been simpler but not stable: compaction inserts a checkpoint into the
 * middle of the transcript, shifting every later index by one, so a client
 * paging by index would silently skip a message or repeat one. Identities
 * survive insertions and suffix deletions (a rewind), and the cursor stays
 * opaque — a client only ever echoes it.
 *
 * **A message window starts at a turn.** The transcript's renderer groups
 * messages into turns beginning at a prompt, a mode prompt, a notification or
 * a compaction checkpoint; a window that began in the middle would hand it
 * assistant and tool rows whose prompt it does not have, which it can neither
 * draw as a turn nor rewind. The start therefore moves back to the nearest
 * turn beginning, so one long turn can make a window larger than the page
 * size — half a turn is not a useful screen.
 */

/** Items one read returns when the caller names no count. */
export const TRANSCRIPT_WINDOW_ITEMS = 40;

/** Most items one read returns: a client-sized window must not be able to
 * ask for the whole transcript again. */
export const MAX_TRANSCRIPT_WINDOW_ITEMS = 200;

/** What a client asks for: the newest window, or the window before the item
 * its `older` cursor names. */
export interface WindowQuery {
  /** The cursor of the next older window (null/absent → the newest one). */
  older?: string | null;
  /** How many items to return. */
  limit?: number;
}

/** One window of a transcript, with the way back. */
export interface WindowPage<T> {
  /** Oldest first, as the transcript holds them. */
  items: T[];
  /** The cursor for the next older window, or null at the transcript's
   * beginning. Clients echo it back to read further. */
  older: string | null;
}

/**
 * The identity of one transcript message, as clients tell two apart (see the
 * web's `messageKey`). Two roles need a field beyond role + timestamp,
 * because a millisecond is not unique:
 *
 * - a tool result is identified by its tool call id (parallel calls finish
 *   together),
 * - a context snapshot by its provider (the dynamic contexts are published
 *   in one loop and share the millisecond).
 */
export function messageIdentityOf(message: AgentMessage): MessageIdentity {
  switch (message.role) {
    case "toolResult":
      return {
        role: message.role,
        timestamp: message.timestamp,
        toolCallId: message.toolCallId,
      };
    case "context":
      return {
        role: message.role,
        timestamp: message.timestamp,
        provider: message.provider,
      };
    default:
      return { role: message.role, timestamp: message.timestamp };
  }
}

/** The cursor naming one message. */
export function messageCursorOf(message: AgentMessage): string {
  return identityCursor(messageIdentityOf(message));
}

/** The cursor of one identity: its fields as JSON. Opaque to clients, so the
 * shape is free to change here. */
export function identityCursor(identity: MessageIdentity): string {
  return JSON.stringify([
    identity.role,
    identity.timestamp,
    identity.toolCallId ?? "",
    identity.provider ?? "",
  ]);
}

/**
 * The window of `items` a query names, with the cursor for the next older
 * one. `startsWindow` says whether the item at an index begins a screen unit
 * (a turn); the window's start moves back to the nearest such item.
 *
 * A cursor that matches no item is a conflict: the message it named was
 * rewound away, so this client's view and the transcript have diverged, and
 * answering with a window it did not ask for would hide that. The client
 * re-reads the newest window instead.
 */
export function readWindow<T>(
  items: readonly T[],
  query: WindowQuery,
  options: {
    /** The cursor naming one item. */
    cursor: (item: T) => string;
    /** Whether the item at this index begins a screen unit. */
    startsWindow: (index: number) => boolean;
  },
): WindowPage<T> {
  const limit = windowLimit(query.limit);
  const older = query.older ?? null;
  const end = older === null
    ? items.length
    : indexOfCursor(items, older, options.cursor);
  let start = Math.max(0, end - limit);
  while (start > 0 && !options.startsWindow(start)) start--;

  const oldest = items[start];
  return {
    items: items.slice(start, end),
    // Reaching the transcript's beginning ends the walk: there is no empty
    // page left to fetch.
    older: start > 0 && oldest !== undefined ? options.cursor(oldest) : null,
  };
}

/** The index the cursor names; a cursor that matches nothing conflicts. */
function indexOfCursor<T>(
  items: readonly T[],
  cursor: string,
  cursorOf: (item: T) => string,
): number {
  const index = items.findIndex((item) => cursorOf(item) === cursor);
  if (index === -1) {
    throw new CoreError(
      "The history changed since this page was read",
      "conflict",
    );
  }
  return index;
}

/** The page size a query asks for, bounded and positive. */
function windowLimit(limit: number | undefined): number {
  if (limit === undefined) return TRANSCRIPT_WINDOW_ITEMS;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CoreError(
      `Invalid page size: ${limit} (expected a positive integer)`,
      "invalid",
    );
  }
  return Math.min(limit, MAX_TRANSCRIPT_WINDOW_ITEMS);
}

/**
 * Whether the message begins a turn in the client's transcript view (see the
 * web's buildTurns): a prompt, a mode prompt (`/plan`), a system notification
 * that started its own run, or a compaction checkpoint (a row of its own).
 * Every other role belongs to the turn before it.
 */
export function startsTranscriptTurn(role: string): boolean {
  return role === "user" || role === "mode" || role === "notification" ||
    role === "checkpoint";
}
