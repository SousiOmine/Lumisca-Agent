import type { AgentMessage } from "../ai/types.ts";
import { CoreError } from "../errors.ts";
import type { MessageRepo, StoredMessage } from "./messages.ts";
import {
  identityCursor,
  messageIdentityOf,
  startsTranscriptTurn,
  type WindowQuery,
} from "./transcript-window.ts";

/**
 * Reading a transcript window STRAIGHT FROM THE STORE.
 *
 * A session agent holds only the model's view in memory (the newest
 * compaction checkpoint onward). The conversation the user reads can be far
 * longer, and loading all of it to answer one page is what made a long
 * conversation slow to open. A page is therefore queried, not sliced: the
 * cursor names a message, the store resolves it to a position, and only the
 * rows of the page are read.
 *
 * Two rules live here. They are the same rules {@link readWindow} applies to
 * an in-memory array — that function stays for the sub-agent transcripts,
 * which have no store — and they must stay the same for both, because a
 * client cannot tell which one answered it.
 *
 * **The cursor is an identity, not a position.** It names the oldest item a
 * client holds (role + timestamp, plus the tool call id for a tool result),
 * and the server resolves it against the live transcript. Positions are not
 * stable: compaction inserts a checkpoint into the middle of the transcript,
 * shifting every later index, so a client paging by index would silently
 * skip or repeat a message. Identities survive insertions and suffix
 * deletions (a rewind), and the cursor stays opaque.
 *
 * **A window starts at a turn.** The transcript's renderer groups messages
 * into turns beginning at a prompt, a mode prompt, a notification or a
 * checkpoint; a window that began in the middle would hand it assistant and
 * tool rows whose prompt it does not have, which it can neither draw as a
 * turn nor rewind. The start therefore moves back to the nearest turn
 * beginning, so one long turn can make a window larger than the page size —
 * half a turn is not a useful screen.
 */

/** Items one read returns when the caller names no count. */
export const TRANSCRIPT_PAGE_ITEMS = 40;

/** Most items one read returns: a client-sized window must not be able to
 * ask for the whole transcript again. */
export const MAX_TRANSCRIPT_PAGE_ITEMS = 200;

/** How many additional rows one page reads while looking for the turn that
 * contains its start. One turn is a prompt plus its replies, so a group or
 * two covers ordinary traffic; the cap only bounds the case where thousands
 * of rows belong to a single turn (a runaway tool loop), where the page is
 * returned as read rather than scanning the conversation to its beginning. */
const BOUNDARY_LOOKBACK = 200;

/** What one read answers. */
export interface TranscriptPage<T> {
  /** Oldest first, as the transcript holds them. */
  items: T[];
  /** The cursor for the next older page, or null at the beginning. */
  older: string | null;
}

/** How one surface's transcript is read: what counts as a page unit, and
 * what a page is projected to. */
export interface PageRules<T> {
  /** Project one row for the client, with the cursor that names it. A row
   * the projection drops returns undefined; it still occupies its turn's
   * extent, so it counts for the boundary but is not returned — and it can
   * never be a cursor, because a client never holds it. */
  project(row: StoredMessage): { item: T; cursor: string } | undefined;
  /** Whether the row begins a screen unit. */
  startsWindow(message: AgentMessage): boolean;
  pageItems?: number;
  maxPageItems?: number;
}

/**
 * Read one page of a session's transcript.
 */
export function readTranscriptPage<T>(
  repo: MessageRepo,
  sessionId: string,
  query: WindowQuery,
  rules: PageRules<T>,
): TranscriptPage<T> {
  const limit = pageLimit(
    query.limit,
    rules.pageItems ?? TRANSCRIPT_PAGE_ITEMS,
    rules.maxPageItems ?? MAX_TRANSCRIPT_PAGE_ITEMS,
  );
  const older = query.older ?? null;
  const total = repo.count(sessionId);
  const end = older === null
    ? total
    : positionOfCursor(repo, sessionId, older, rules.project);

  // The page's own rows plus the lookback before them. `readFrom` is the
  // absolute position of the first row read, which is what turns an index
  // into a position.
  const pageStart = Math.max(0, end - limit);
  const want = end - Math.max(0, pageStart - BOUNDARY_LOOKBACK);
  const rows = repo.listWindow(sessionId, {
    // The newest page has no row after it to bound by (an OFFSET at the end
    // matches nothing), so it is the store's own "newest" query.
    beforeIndex: end === total ? null : end,
    limit: want,
  });
  const readFrom = end - rows.length;
  // `rows[0]` sits at `readFrom`. Walk back from the page's start to the
  // nearest row that begins a unit; stopping at `readFrom` means the lookback
  // ran out, and the page is returned as read rather than growing.
  let start = pageStart;
  while (
    start > readFrom && !rules.startsWindow(rows[start - readFrom]!.message)
  ) {
    start--;
  }

  const page = rows.slice(start - readFrom);
  // One projection pass: `items` is what the client draws, and the first
  // projected row carries the cursor for the next page (a dropped row is
  // never held by a client, so it cannot name anything). A page whose whole
  // extent is dropped answers null rather than a cursor that would land on
  // the same rows again.
  const items: T[] = [];
  let firstCursor: string | undefined;
  for (const row of page) {
    const projected = rules.project(row);
    if (projected === undefined) continue;
    if (firstCursor === undefined) firstCursor = projected.cursor;
    items.push(projected.item);
  }
  return {
    items,
    older: start > 0 && firstCursor !== undefined ? firstCursor : null,
  };
}

/** The position a cursor names. A cursor that matches nothing is a conflict:
 * the message it named was rewound away, so the client's view and the
 * transcript have diverged, and answering with a window it did not ask for
 * would hide that. */
function positionOfCursor<T>(
  repo: MessageRepo,
  sessionId: string,
  cursor: string,
  project: (row: StoredMessage) => { item: T; cursor: string } | undefined,
): number {
  const position = repo.positionOf(
    sessionId,
    (row) => project(row)?.cursor === cursor,
  );
  if (position === undefined) {
    throw new CoreError(
      "The history changed since this page was read",
      "conflict",
    );
  }
  return position;
}

/** The page size a query asks for, bounded and positive. */
function pageLimit(
  limit: number | undefined,
  fallback: number,
  max: number,
): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CoreError(
      `Invalid page size: ${limit} (expected a positive integer)`,
      "invalid",
    );
  }
  return Math.min(limit, max);
}

/** The cursor of one message: the identity form both paging implementations
 * produce, so a client holds one kind of string whichever answered it. */
export function messageCursor(message: AgentMessage): string {
  return identityCursor(messageIdentityOf(message));
}

/** Whether a message begins a turn in code mode's transcript view. */
export function startsTurnRow(message: AgentMessage): boolean {
  return startsTranscriptTurn(message.role);
}
