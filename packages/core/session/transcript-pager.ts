import type { AgentMessage } from "../ai/types.ts";
import { CoreError } from "../errors.ts";
import type { MessageRepo, StoredMessage, TranscriptRows } from "./messages.ts";
import {
  identityCursor,
  MAX_TRANSCRIPT_WINDOW_ITEMS,
  messageIdentityOf,
  TRANSCRIPT_WINDOW_ITEMS,
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
 * **A window prefers to start at a turn.** The transcript's renderer groups
 * messages into turns beginning at a prompt, a mode prompt, a notification or
 * a checkpoint, and a window that began in the middle hands it assistant and
 * tool rows whose prompt it does not have. The start therefore moves back to
 * the nearest turn beginning — within a bounded lookback. A turn longer than
 * that budget (a runaway tool loop) makes the page begin inside it, and the
 * renderer draws that head as a partial turn. Reading to the prompt instead
 * was unbounded: opening a conversation would have cost its longest turn.
 */

/** How far back a page looks for the row that begins its turn.
 *
 * A turn is a prompt plus the replies it produced, so a group or two of rows
 * covers ordinary traffic, and the walk stops as soon as it finds the prompt.
 * A runaway tool loop makes one turn arbitrarily long: this is where that
 * case stops being "read until the prompt", because the screen must not wait
 * on a turn of thousands of rows to show its last forty.
 *
 * A page that runs out of budget is returned as read, beginning inside the
 * turn — and the renderer draws such a head as a partial turn rather than
 * dropping it (see the web's buildTurns). The alternative is what this
 * budget exists to avoid: opening a conversation costs its whole longest
 * turn. */
const BOUNDARY_LOOKBACK = MAX_TRANSCRIPT_WINDOW_ITEMS * 2;

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
  /** Which rows a page counts (see MessageRepo.listWindow and
   * TranscriptRows). Required, because a page is a count of screen units and
   * only the surface knows what its screen draws: a conversation reads
   * `"conversation"` (its entries), code mode `"all"` (its transcript is the
   * model's history, minus the rows the renderer drops). */
  rows: TranscriptRows;
  pageItems?: number;
  maxPageItems?: number;
}

export function readTranscriptPage<T>(
  repo: MessageRepo,
  sessionId: string,
  query: WindowQuery,
  rules: PageRules<T>,
): TranscriptPage<T> {
  const limit = pageLimit(
    query.limit,
    rules.pageItems ?? TRANSCRIPT_WINDOW_ITEMS,
    rules.maxPageItems ?? MAX_TRANSCRIPT_WINDOW_ITEMS,
  );
  const rows = rules.rows;
  const older = query.older ?? null;
  // Every position here is in `rows`' scope, so a page counts what the client
  // draws (see TranscriptRows).
  const total = repo.count(sessionId, rows);
  const end =
    older === null
      ? total
      : positionOfCursor(repo, sessionId, older, rules.project, rows);

  // One contiguous read of the transcript's rows from position `at` up to
  // (not including) `until`. The read that reaches the transcript's end has
  // no row after it to bound by (an OFFSET at the end matches nothing), so it
  // is the store's own "newest" query.
  const readRows = (at: number, until: number) =>
    repo.listWindow(sessionId, {
      beforeIndex: until === total ? null : until,
      limit: until - at,
      rows,
    });
  const pageStart = Math.max(0, end - limit);
  let start = turnStartAtOrBefore(pageStart, end, rules.startsWindow, readRows);
  let projected = projectPage(readRows(start, end), rules);
  // The scope is a SUPERSET of what the client draws (the projection, not
  // SQL, decides what an entry is), so a page of scoped rows can still
  // project to nothing: a prompt with neither words nor files, a `send_chat`
  // that sent nothing. Handing that back as `{ items: [], older: null }` is
  // the answer "an empty conversation, and nothing before it" — a screen with
  // no way out, because every later read asks for the same window. So the
  // window keeps growing backwards until it holds something drawable, within
  // the same bound as the turn walk.
  const floor = Math.max(0, end - limit - BOUNDARY_LOOKBACK);
  while (projected.items.length === 0 && start > 0) {
    const next = turnStartAtOrBefore(
      Math.max(floor, start - limit),
      start,
      rules.startsWindow,
      readRows,
    );
    if (next >= start) break;
    start = next;
    projected = projectPage(readRows(start, end), rules);
  }
  return {
    items: projected.items,
    // `older` names the entry that begins the page: the reader can hold only
    // something it draws, so a page with nothing drawable names nothing.
    older:
      start > 0 && projected.firstCursor !== undefined
        ? projected.firstCursor
        : null,
  };
}

/** One projection pass: what the client draws, and the cursor naming the
 * first of it (the way back is anchored on a row the client holds). */
function projectPage<T>(
  page: readonly StoredMessage[],
  rules: PageRules<T>,
): { items: T[]; firstCursor: string | undefined } {
  const items: T[] = [];
  let firstCursor: string | undefined;
  for (const row of page) {
    const projected = rules.project(row);
    if (projected === undefined) continue;
    if (firstCursor === undefined) firstCursor = projected.cursor;
    items.push(projected.item);
  }
  return { items, firstCursor };
}

/** The position the window that ends at `end` must START at: walked back
 * from `pageStart` to the row that begins its turn, within
 * {@link BOUNDARY_LOOKBACK}.
 *
 * The walk stops at the prompt, at the transcript's head (its first row
 * always begins a turn), or when the budget runs out — whichever comes first.
 * Running out means the page begins inside an unusually long turn, which the
 * renderer draws as a partial turn; a page read as far as the lookup allows
 * is the cost ceiling, and it is what keeps opening a screen independent of
 * how long the conversation's turns got. */
function turnStartAtOrBefore(
  pageStart: number,
  end: number,
  startsWindow: (message: AgentMessage) => boolean,
  readRows: (at: number, until: number) => StoredMessage[],
): number {
  const floor = Math.max(0, pageStart - BOUNDARY_LOOKBACK);
  if (floor === pageStart) return pageStart;
  const rows = readRows(floor, end);
  for (let at = pageStart - floor; at >= 0; at--) {
    if (startsWindow(rows[at]!.message)) return floor + at;
  }
  // Nothing in the budget begins a turn: the page starts where it was going
  // to, and the renderer draws that head as part of the turn it fell into.
  return pageStart;
}

/** The position a cursor names. A cursor that matches nothing is a conflict:
 * the message it named was rewound away, so the client's view and the
 * transcript have diverged, and answering with a window it did not ask for
 * would hide that. The position is in the page's own scope: a cursor names a
 * row the client DRAWS, and `rows` is what the positions count. */
function positionOfCursor<T>(
  repo: MessageRepo,
  sessionId: string,
  cursor: string,
  project: (row: StoredMessage) => { item: T; cursor: string } | undefined,
  rows: TranscriptRows,
): number {
  const position = repo.positionOf(
    sessionId,
    (row) => project(row)?.cursor === cursor,
    rows,
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
