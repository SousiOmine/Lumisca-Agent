import type { RequestShape } from "../ai/types.ts";
import type { LumiscaDb } from "../db/mod.ts";

/** One recorded request shape (see RequestShape). */
export interface RequestShapeRecord extends RequestShape {
  id: number;
  sessionId: string;
  /** When the request was sent (epoch ms). */
  createdAt: number;
}

/**
 * The session's request-shape record: what the model was sent, as far as
 * cache reuse is concerned.
 *
 * The provider serves a request from its prompt cache only up to the first
 * token that differs from the previous request, so a session's cache reads
 * are explained by exactly three events: the first request of a session
 * (`initial`), a changed head — system prompt or tool schemas
 * (`head-changed`), and a rewritten history — compaction or rewind
 * (`history-rewritten`). Everything else is an append-extension of the
 * previous request and reuses the shared prefix.
 *
 * The loop reports every request (see ai/agent.ts); only these three are
 * recorded, so a session's table stays proportional to its real cache
 * breaks, not to its step count. Nothing reads the table during a run: it
 * is the post-mortem answer to "why did the cache read drop here?".
 */
export interface RequestShapeRepo {
  record(sessionId: string, shape: RequestShape, createdAt?: number): void;
  /** The session's recorded shapes, oldest first. `limit` keeps the newest
   * entries when the table is longer (the oldest are the least useful). */
  list(sessionId: string, limit?: number): RequestShapeRecord[];
}

export function createRequestShapeRepo(db: LumiscaDb): RequestShapeRepo {
  const insertStmt = db.db.prepare(`
    INSERT INTO request_shapes
      (session_id, created_at, change, head_hash, messages_hash, message_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const listStmt = db.db.prepare(
    "SELECT * FROM request_shapes WHERE session_id = ? ORDER BY id",
  );

  interface ShapeRow {
    id: number;
    session_id: string;
    created_at: number;
    change: string;
    head_hash: string;
    messages_hash: string;
    message_count: number;
  }

  function toRecord(row: ShapeRow): RequestShapeRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      createdAt: row.created_at,
      change: row.change as RequestShape["change"],
      headHash: row.head_hash,
      messagesHash: row.messages_hash,
      messageCount: row.message_count,
    };
  }

  return {
    record(sessionId, shape, createdAt = Date.now()): void {
      insertStmt.run(
        sessionId,
        createdAt,
        shape.change ?? "append",
        shape.headHash,
        shape.messagesHash,
        shape.messageCount,
      );
    },

    list(sessionId: string, limit?: number): RequestShapeRecord[] {
      const rows = listStmt.all(sessionId) as unknown as ShapeRow[];
      const records = rows.map(toRecord);
      return limit === undefined ? records : records.slice(-limit);
    },
  };
}
