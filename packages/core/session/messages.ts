import type { AgentMessage } from "../ai/types.ts";
import type { LumiscaDb } from "../db/mod.ts";

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
