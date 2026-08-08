import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
      const timestamp = (message as { timestamp?: number }).timestamp ??
        Date.now();
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

    deleteBySession(sessionId: string): void {
      deleteStmt.run(sessionId);
    },
  };
}
