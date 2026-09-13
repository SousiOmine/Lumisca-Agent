import type { AgentMessage } from "../ai/types.ts";
import type { LumiscaDb } from "../db/mod.ts";
import { CoreError } from "../errors.ts";

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: string;
  message: AgentMessage;
  timestamp: number;
}

export interface MessageRepo {
  append(sessionId: string, message: AgentMessage): StoredMessage;
  list(sessionId: string): StoredMessage[];
  listMessages(sessionId: string): AgentMessage[];
  /** Delete every row at or after `index` (a 0-based transcript position;
   * rows are inserted in transcript order, so rowid == position). Used by
   * the rewind feature: positional (not timestamp-based) so messages that
   * share a millisecond with the rewind boundary are handled exactly. */
  deleteFrom(sessionId: string, index: number): void;
  /** Replace the `count` rows from `index` on with `message`: the row at
   * `index` becomes the message, the remaining rows of the range are
   * deleted. Positional like deleteFrom, and rowid order is preserved, so
   * a later listMessages reproduces the in-memory transcript — the context
   * compaction uses this to replace a compacted span with its checkpoint
   * (the retained messages after the range keep their rows). Throws
   * `not_found` when the span's first message is not in the session; a span
   * whose end lies past the last persisted row (the newest messages of a
   * run in flight) deletes everything from its first row on. */
  replaceRange(
    sessionId: string,
    index: number,
    count: number,
    message: AgentMessage,
  ): void;
  deleteBySession(sessionId: string): void;
}

/** Version of the stored message envelope. Bump when the AgentMessage
 * shape changes (e.g. after a pi major upgrade) and add a normalizer to
 * decodeStoredMessage so older rows keep decoding. */
const STORAGE_VERSION = 1;

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
        return envelope.message;
      default:
        // Unknown (future) version: keep the payload rather than losing it.
        return envelope.message;
    }
  }
  // Legacy row: raw AgentMessage JSON (pre-stamping).
  return parsed as AgentMessage;
}

export function createMessageRepo(db: LumiscaDb): MessageRepo {
  const insertStmt = db.db.prepare(`
    INSERT INTO messages (id, session_id, role, content, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);
  const listStmt = db.db.prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY rowid",
  );
  const deleteStmt = db.db.prepare(
    "DELETE FROM messages WHERE session_id = ?",
  );
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
  // Positional row lookup (same rowid == transcript-position rule as above).
  const rowidAtStmt = db.db.prepare(`
    SELECT rowid FROM messages
    WHERE session_id = ?
    ORDER BY rowid
    LIMIT 1 OFFSET ?
  `);
  const overwriteStmt = db.db.prepare(`
    UPDATE messages SET role = ?, content = ?, timestamp = ?
    WHERE rowid = ?
  `);
  // Bounded by the two rows of this session's range, so no other session's
  // rows (which share the global rowid space) can fall inside it.
  const deleteBetweenStmt = db.db.prepare(
    "DELETE FROM messages WHERE rowid > ? AND rowid <= ?",
  );
  // Fallback for a span whose end has no row yet: everything after the
  // span's first row belongs to the span (nothing beyond it is persisted).
  const deleteAfterRowidStmt = db.db.prepare(
    "DELETE FROM messages WHERE session_id = ? AND rowid > ?",
  );

  /** rowid of the row at a 0-based transcript position (undefined when the
   * session holds no such row). */
  const rowidAt = (sessionId: string, index: number): number | undefined => {
    const row = rowidAtStmt.get(sessionId, index) as
      | { rowid: number }
      | undefined;
    return row?.rowid;
  };

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

  return {
    append(sessionId, message): StoredMessage {
      const id = crypto.randomUUID();
      const timestamp = timestampOf(message);
      insertStmt.run(
        id,
        sessionId,
        message.role,
        encodeStoredMessage(message),
        timestamp,
      );
      return {
        id,
        sessionId,
        role: message.role,
        message,
        timestamp,
      };
    },

    list,

    listMessages(sessionId: string): AgentMessage[] {
      return list(sessionId).map((m) => m.message);
    },

    deleteFrom(sessionId: string, index: number): void {
      deleteFromStmt.run(sessionId, sessionId, index);
    },

    replaceRange(
      sessionId: string,
      index: number,
      count: number,
      message: AgentMessage,
    ): void {
      const first = rowidAt(sessionId, index);
      if (first === undefined) {
        throw new CoreError(
          `Message not found: ${sessionId} at ${index}`,
          "not_found",
        );
      }
      overwriteStmt.run(
        message.role,
        encodeStoredMessage(message),
        timestampOf(message),
        first,
      );
      if (count > 1) {
        // The span's end may lie past the last persisted row (the newest
        // messages of a run in flight have no row yet): then every row after
        // the span's first one belongs to the span.
        const last = rowidAt(sessionId, index + count - 1);
        if (last === undefined) {
          deleteAfterRowidStmt.run(sessionId, first);
        } else {
          deleteBetweenStmt.run(first, last);
        }
      }
    },

    deleteBySession(sessionId: string): void {
      deleteStmt.run(sessionId);
    },
  };
}
