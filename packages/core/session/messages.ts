import type { AgentMessage } from "../ai/types.ts";
import type { ContextUsageMessageLike } from "../shared/context-usage.ts";
import type { LumiscaDb } from "../db/mod.ts";
import { reduceMessage } from "./prune.ts";

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: string;
  message: AgentMessage;
  timestamp: number;
}

/** Time window of a history search: `from` and `to` are epoch ms and both
 * inclusive; `null` leaves that side unbounded. */
export interface MessageWindow {
  from: number | null;
  to: number | null;
}

export interface MessageRepo {
  append(sessionId: string, message: AgentMessage): StoredMessage;
  list(sessionId: string): StoredMessage[];
  listMessages(sessionId: string): AgentMessage[];
  /** The session's messages whose timestamp lies in `window`, in transcript
   * order. Backed by the `(session_id, timestamp)` index, so a search reads
   * only the rows of the period it asks about. */
  listBetween(sessionId: string, window: MessageWindow): StoredMessage[];
  /** The part of the transcript the model is shown: the newest compaction
   * checkpoint and everything after it, in transcript order. A conversation
   * that was never compacted is returned whole. This is what a session agent
   * loads when a conversation is opened — the model's view, not the
   * conversation's whole history (see session/transcript-window.ts). */
  listModelView(sessionId: string): StoredMessage[];
  /** One window of the conversation as a client draws it: up to `limit`
   * rows ending just before `beforeIndex` (a 0-based transcript position),
   * or the newest window when it is `null`. Rows come back oldest first.
   * The window's start is pulled back to `startsWindow` — a page must begin
   * at a turn, not in the middle of one (see session/transcript-pager.ts). */
  listWindow(
    sessionId: string,
    query: { beforeIndex: number | null; limit: number },
  ): StoredMessage[];
  /** The 0-based transcript position of the first row matching `match`, or
   * undefined when none does. Backs the cursor (see transcript-pager): the
   * cursor names a message, and the store answers where it is. */
  positionOf(
    sessionId: string,
    match: (row: StoredMessage) => boolean,
  ): number | undefined;
  /** The newest rows that could be something the conversation SHOWS, newest
   * first, at most `limit`.
   *
   * This is a candidate set, not an answer: whether a row is a conversation
   * entry is the projection's decision (see agent/stella-stream.ts), and only
   * a projected row may become what a sidebar row says. The filter is here
   * because the alternative — decoding rows until one projects — would read
   * a whole transcript of tool traffic to find one message, while every row
   * a conversation can show is one of three kinds (see the SQL comment).
   *
   * `limit` bounds how many candidates a caller reads; a caller looking for
   * the newest entry retries with a larger limit rather than scanning the
   * session. */
  newestConversationRows(sessionId: string, limit: number): StoredMessage[];
  /** How many rows the session holds (a page's end is the row count). */
  count(sessionId: string): number;
  /** The `usage` of every assistant row that reported one, in transcript
   * order — the input of the context meter. Read from the store rather than
   * from memory because the agent holds only the model's view, while the
   * meter describes the whole conversation. */
  usageRows(sessionId: string): ContextUsageMessageLike[];
  /** Replace the payload of every row before the newest checkpoint, keeping
   * its identity and position (see session/prune.ts). Returns how many rows
   * changed and the bytes their payloads held, which is what a caller needs
   * to decide whether the file is worth rewriting (db/vacuum.ts). Idempotent:
   * a row already reduced is left alone. */
  pruneCondensed(
    sessionId: string,
  ): { changed: number; freedBytes: number };
  /** Delete every row at or after `index` (a 0-based transcript position;
   * rows are inserted in transcript order, so rowid == position). Used by
   * the rewind feature: positional (not timestamp-based) so messages that
   * share a millisecond with the rewind boundary are handled exactly. */
  deleteFrom(sessionId: string, index: number): void;
  /** Insert `message` at the 0-based transcript position `index`, pushing
   * the rows at and after it one position later. Used by the context
   * compaction, which inserts its checkpoint at the cut and keeps every
   * message around it. An `index` at or past the last row appends. The
   * rewrite runs in one transaction: a failure leaves the session's rows
   * exactly as they were. */
  insertAt(
    sessionId: string,
    index: number,
    message: AgentMessage,
  ): StoredMessage;
  deleteBySession(sessionId: string): void;
}

/** Version of the stored message envelope. Bump when the AgentMessage
 * shape changes (e.g. after a pi major upgrade) and add a normalizer to
 * decodeStoredMessage so older rows keep decoding. */
const STORAGE_VERSION = 2;

interface StoredEnvelope {
  v: number;
  message: AgentMessage;
}

/** Envelope format: `{ v: <version>, message: <AgentMessage> }`. The
 * version stamp decouples the database from pi's message shape — a future
 * pi change is handled by a normalizer, not by losing old history. */
function encodeStoredMessage(message: AgentMessage): string {
  return JSON.stringify({ v: STORAGE_VERSION, message });
}

/** The timestamp column of a message (every AgentMessage carries one; a
 * value-less message is stamped now so the column stays NOT NULL). */
function timestampOf(message: AgentMessage): number {
  return (message as { timestamp?: number }).timestamp ?? Date.now();
}

/** Decode a stored `content` cell. Rows written before versioning (raw
 * AgentMessage JSON) decode as-is; versioned rows run a per-version
 * normalizer. */
function decodeStoredMessage(content: string): AgentMessage {
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed === "object" && parsed !== null && "v" in parsed) {
    const envelope = parsed as StoredEnvelope;
    switch (envelope.v) {
      case 1:
        return upgradeFromV1(envelope.message);
      case 2:
        return envelope.message;
      default:
        // Unknown (future) version: keep the payload rather than losing it.
        return envelope.message;
    }
  }
  // Legacy row: raw AgentMessage JSON (pre-stamping) — shaped like v1, so
  // it runs the same normalizer.
  return upgradeFromV1(parsed as AgentMessage);
}

/** Bring a v1 message up to the current shape: mode messages gained
 * `images` (the pictures attached to the prompt in the composer; empty
 * when none were attached), which rows written before it do not carry.
 * Every other role is unchanged. */
function upgradeFromV1(message: AgentMessage): AgentMessage {
  return message.role === "mode" ? { ...message, images: [] } : message;
}

export function createMessageRepo(db: LumiscaDb): MessageRepo {
  const insertStmt = db.db.prepare(`
    INSERT INTO messages (id, session_id, role, content, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);
  const listStmt = db.db.prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY rowid",
  );
  // One statement per bounded/unbounded combination: SQLite cannot compare
  // against a NULL bound, so an absent side is its own query rather than a
  // runtime rewrite of the SQL text.
  const listBetweenStmt = db.db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ? AND timestamp >= ? AND timestamp <= ?
    ORDER BY rowid
  `);
  const listSinceStmt = db.db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ? AND timestamp >= ?
    ORDER BY rowid
  `);
  const listUntilStmt = db.db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ? AND timestamp <= ?
    ORDER BY rowid
  `);
  const deleteStmt = db.db.prepare(
    "DELETE FROM messages WHERE session_id = ?",
  );
  // The stored payload length of one row: what the row held before a prune
  // replaced it (see pruneCondensed).
  const contentLengthStmt = db.db.prepare(
    "SELECT length(content) AS n FROM messages WHERE id = ?",
  );
  // Rewriting a row's payload in place (context compaction's prune): the id,
  // position and timestamp stay, so every cursor over the transcript still
  // names the same row.
  const updateContentStmt = db.db.prepare(
    "UPDATE messages SET content = ? WHERE id = ?",
  );
  // The model's view: the newest compaction checkpoint and everything after
  // it. The partial index (schema.ts) makes finding that checkpoint cheap
  // however long the conversation is; without it every open scanned the
  // session's rows to the end.
  const modelViewStmt = db.db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ?1
      AND rowid >= COALESCE(
        (SELECT rowid FROM messages
         WHERE session_id = ?1 AND role = 'checkpoint'
         ORDER BY rowid DESC LIMIT 1),
        -1
      )
    ORDER BY rowid
  `);
  // One page ending at a position: the newest `limit` rows strictly before
  // the 0-based transcript position `beforeIndex`, oldest first. The bound
  // is resolved to a rowid with the same OFFSET rule deleteFrom uses, so a
  // caller counts rows the way the rest of the store does and never has to
  // know a rowid (which insertAt rewrites). The subquery projects rowid
  // explicitly: a bare `SELECT *` does not carry it out, and the outer ORDER
  // BY is what restores transcript order after the inner DESC limit. A null
  // bound (no older page requested) reads the newest rows instead, which is
  // its own statement.
  const windowFromStmt = db.db.prepare(`
    SELECT * FROM (
      SELECT rowid AS rid, * FROM messages
      WHERE session_id = ?
        AND rowid < (
          SELECT rowid FROM messages
          WHERE session_id = ?
          ORDER BY rowid
          LIMIT 1 OFFSET ?
        )
      ORDER BY rowid DESC LIMIT ?
    ) ORDER BY rid
  `);
  const windowNewestStmt = db.db.prepare(`
    SELECT * FROM (
      SELECT rowid AS rid, * FROM messages
      WHERE session_id = ?
      ORDER BY rowid DESC LIMIT ?
    ) ORDER BY rid
  `);
  // The newest rows that could be a conversation entry, newest first (see
  // newestConversationRows). A conversation can show exactly three kinds of
  // row — a prompt (`user`; `mode` is code-mode-only but projected the same
  // way), and the result of a successful `send_chat` (see
  // agent/stella-stream.ts) — so the filter names them and the scan stays
  // inside the session's index range however long the transcript is.
  //
  // The tool name is read through `COALESCE` because the store holds two
  // envelopes: rows this build wrote (`{ v, message }`) and rows from before
  // the version stamp (a bare message). `decodeStoredMessage` reads both, so
  // this query has to see both — a filter that only understood one would
  // leave a conversation's last message invisible in the sidebar while the
  // conversation itself showed it.
  const newestEntryRowsStmt = db.db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ?1
      AND (
        role IN ('user', 'mode')
        OR (
          role = 'toolResult'
          AND COALESCE(
            json_extract(content, '$.message.toolName'),
            json_extract(content, '$.toolName')
          ) = 'send_chat'
          AND COALESCE(
            json_extract(content, '$.message.isError'),
            json_extract(content, '$.isError'),
            0
          ) = 0
        )
      )
    ORDER BY rowid DESC
    LIMIT ?2
  `);
  // Positional truncation: rows are inserted in transcript order, so the
  // row at OFFSET `index` is the first message to remove (an OFFSET past
  // the last row matches nothing — nothing persisted to delete).
  const deleteFromStmt = db.db.prepare(`
    DELETE FROM messages
    WHERE session_id = ?
      AND rowid >= (
        SELECT rowid FROM messages
        WHERE session_id = ?
        ORDER BY rowid
        LIMIT 1 OFFSET ?
      )
  `);

  function toStored(row: {
    id: string;
    session_id: string;
    role: string;
    content: string;
    timestamp: number;
  }): StoredMessage {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      message: decodeStoredMessage(row.content),
      timestamp: row.timestamp,
    };
  }

  const list = (sessionId: string): StoredMessage[] => {
    const rows = listStmt.all(sessionId) as Array<
      Parameters<typeof toStored>[0]
    >;
    return rows.map(toStored);
  };

  /** Write one row and return its stored form. `id` is reused when an
   * existing row is rewritten (insertAt), so a message keeps its identity. */
  const insertRow = (
    sessionId: string,
    message: AgentMessage,
    id = crypto.randomUUID(),
  ): StoredMessage => {
    const timestamp = timestampOf(message);
    insertStmt.run(
      id,
      sessionId,
      message.role,
      encodeStoredMessage(message),
      timestamp,
    );
    return { id, sessionId, role: message.role, message, timestamp };
  };

  return {
    append(sessionId, message): StoredMessage {
      return insertRow(sessionId, message);
    },

    list,

    listMessages(sessionId: string): AgentMessage[] {
      return list(sessionId).map((m) => m.message);
    },

    listBetween(sessionId: string, window): StoredMessage[] {
      const rows =
        (window.from === null
          ? window.to === null
            ? listStmt.all(sessionId)
            : listUntilStmt.all(sessionId, window.to)
          : window.to === null
          ? listSinceStmt.all(sessionId, window.from)
          : listBetweenStmt.all(sessionId, window.from, window.to)) as Array<
            Parameters<typeof toStored>[0]
          >;
      return rows.map(toStored);
    },

    listModelView(sessionId: string): StoredMessage[] {
      const rows = modelViewStmt.all(sessionId) as Array<
        Parameters<typeof toStored>[0]
      >;
      return rows.map(toStored);
    },

    listWindow(sessionId, query): StoredMessage[] {
      const rows =
        (query.beforeIndex === null
          ? windowNewestStmt.all(sessionId, query.limit)
          : windowFromStmt.all(
            sessionId,
            sessionId,
            query.beforeIndex,
            query.limit,
          )) as Array<Parameters<typeof toStored>[0]>;
      return rows.map(toStored);
    },

    newestConversationRows(sessionId, limit): StoredMessage[] {
      const rows = newestEntryRowsStmt.all(sessionId, limit) as Array<
        Parameters<typeof toStored>[0]
      >;
      return rows.map(toStored);
    },

    positionOf(sessionId, match): number | undefined {
      // The rows are decoded because the cursor is an identity, not a
      // column: it names role + timestamp (+ tool call id), which only the
      // message itself carries. Called once per page (a client that reaches
      // the top), so the decode of the session's rows is acceptable; the
      // alternative would be a cursor column the store does not have.
      const rows = list(sessionId);
      for (let index = 0; index < rows.length; index++) {
        if (match(rows[index]!)) return index;
      }
      return undefined;
    },

    count(sessionId): number {
      const row = db.db.prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE session_id = ?",
      ).get(sessionId) as { n: number };
      return Number(row.n);
    },

    usageRows(sessionId): ContextUsageMessageLike[] {
      // The usage object is pulled out of the stored JSON by SQLite, so a
      // long conversation does not pay for decoding every row's content just
      // to read four numbers (and its images, on a session with screenshots,
      // would otherwise be materialized on every snapshot).
      const rows = db.db.prepare(`
        SELECT
          json_extract(content, '$.message.usage.input') AS input,
          json_extract(content, '$.message.usage.cacheRead') AS cacheRead,
          json_extract(content, '$.message.usage.cacheWrite') AS cacheWrite
        FROM messages
        WHERE session_id = ? AND role = 'assistant'
        ORDER BY rowid
      `).all(sessionId) as Array<{
        input: number | null;
        cacheRead: number | null;
        cacheWrite: number | null;
      }>;
      return rows.map((row) => ({
        role: "assistant",
        usage: {
          input: row.input,
          cacheRead: row.cacheRead,
          cacheWrite: row.cacheWrite,
        },
      }));
    },

    deleteFrom(sessionId: string, index: number): void {
      deleteFromStmt.run(sessionId, sessionId, index);
    },

    insertAt(
      sessionId: string,
      index: number,
      message: AgentMessage,
    ): StoredMessage {
      const rows = listStmt.all(sessionId) as Array<
        Parameters<typeof toStored>[0]
      >;
      const suffix = rows.slice(index);
      // SQLite rowids are shared by every session, so shifting them by one
      // could collide with another session's row. Rewriting the session's
      // own suffix (delete, insert the new row, re-insert the suffix with
      // its original id/content/timestamp) is collision-free and restores
      // the "rowid order == transcript order" invariant the positional
      // operations rely on. An index past the last row appends.
      return insertAtInTransaction(sessionId, index, suffix, message);
    },

    /** Reduce every row before the newest checkpoint that has not been
     * reduced yet, and return how many were changed and how many bytes the
     * replaced payloads held.
     *
     * Called when a checkpoint is inserted and when a conversation is opened:
     * the first keeps the store from growing with work nothing reads again,
     * the second repairs a process that died between the two. A row is
     * rewritten in place (same id, same position), so the transcript's order
     * and every cursor over it are untouched.
     *
     * The byte count is what lets the caller notice that the FILE is now
     * mostly free pages and worth rewriting (see db/vacuum.ts): SQLite
     * reuses freed pages but never shrinks on its own. */
    pruneCondensed(sessionId): { changed: number; freedBytes: number } {
      const contentLength = (id: string): number => {
        const row = contentLengthStmt.get(id) as { n: number } | undefined;
        return Number(row?.n ?? 0);
      };
      const rows = list(sessionId);
      let cut = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]!.role === "checkpoint") {
          cut = i;
          break;
        }
      }
      if (cut === 0) return { changed: 0, freedBytes: 0 };
      let changed = 0;
      let freedBytes = 0;
      for (let i = 0; i < cut; i++) {
        const row = rows[i]!;
        const reduced = reduceMessage(row.message);
        if (!reduced.changed) continue;
        const next = encodeStoredMessage(reduced.message);
        freedBytes += contentLength(row.id) - next.length;
        updateContentStmt.run(next, row.id);
        changed++;
      }
      return { changed, freedBytes: Math.max(0, freedBytes) };
    },

    deleteBySession(sessionId: string): void {
      deleteStmt.run(sessionId);
    },
  };

  /** The insertAt body: the suffix rewrite runs in one transaction, so a
   * failure leaves the session's rows exactly as they were. */
  function insertAtInTransaction(
    sessionId: string,
    index: number,
    suffix: Array<Parameters<typeof toStored>[0]>,
    message: AgentMessage,
  ): StoredMessage {
    const write = (): StoredMessage => {
      if (suffix.length > 0) deleteFromStmt.run(sessionId, sessionId, index);
      const stored = insertRow(sessionId, message);
      for (const row of suffix) {
        insertStmt.run(
          row.id,
          sessionId,
          row.role,
          row.content,
          row.timestamp,
        );
      }
      return stored;
    };
    db.db.exec("BEGIN IMMEDIATE");
    try {
      const stored = write();
      db.db.exec("COMMIT");
      return stored;
    } catch (error) {
      db.db.exec("ROLLBACK");
      throw error;
    }
  }
}
