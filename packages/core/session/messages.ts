import type { AgentMessage } from "npm:@earendil-works/pi-agent-core@0.83.0";
import type { LumiscaDb } from "../db/mod.ts";

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: string;
  message: AgentMessage;
  parentId: string | null;
  timestamp: number;
}

export interface MessageRepo {
  append(sessionId: string, message: AgentMessage, parentId?: string | null): StoredMessage;
  list(sessionId: string): StoredMessage[];
  listMessages(sessionId: string): AgentMessage[];
  deleteBySession(sessionId: string): void;
}

export function createMessageRepo(db: LumiscaDb): MessageRepo {
  const insertStmt = db.db.prepare(`
    INSERT INTO messages (id, session_id, role, content, parent_id, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
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
    parent_id: string | null;
    timestamp: number;
  }): StoredMessage {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      message: JSON.parse(row.content) as AgentMessage,
      parentId: row.parent_id,
      timestamp: row.timestamp,
    };
  }

  return {
    append(sessionId, message, parentId = null): StoredMessage {
      const id = crypto.randomUUID();
      const timestamp = (message as { timestamp?: number }).timestamp ?? Date.now();
      insertStmt.run(
        id,
        sessionId,
        message.role,
        JSON.stringify(message),
        parentId,
        timestamp,
      );
      return { id, sessionId, role: message.role, message, parentId, timestamp };
    },

    list(sessionId: string): StoredMessage[] {
      const rows = listStmt.all(sessionId) as Array<
        Parameters<typeof toStored>[0]
      >;
      return rows.map(toStored);
    },

    listMessages(sessionId: string): AgentMessage[] {
      return this.list(sessionId).map((m) => m.message);
    },

    deleteBySession(sessionId: string): void {
      deleteStmt.run(sessionId);
    },
  };
}
