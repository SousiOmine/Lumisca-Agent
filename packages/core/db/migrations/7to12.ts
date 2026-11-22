import type { Database } from "bun:sqlite";
import { addColumnIfMissing } from "./helpers.ts";

/** Migrations 7 through 12 in schema order. */
export const migrations7to12: ReadonlyArray<(db: Database) => void> = [
  // Session listing filters by workspace (`listByWorkspace`); without this
  // index every list is a full table scan.
  (db) =>
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id)",
    ),
  // Context accounting: assistant rows used to store the provider's whole
  // prompt in `usage.input`, while `usage.input` means the *uncached*
  // prompt tokens (the cached part is `usage.cacheRead`/`cacheWrite`).
  // Every cached token was counted twice, so the context meter read ~2x the
  // real prompt and the cache hit rate looked halved. Those rows are the
  // ones whose stored `total` is exactly `input + output` (the transport's
  // own prompt + completion); dropping the cached parts from `input`
  // restores the uncached count in place.
  (db) =>
    db.exec(`
      UPDATE messages
      SET content = json_set(
        content,
        '$.message.usage.input',
        max(
          0,
          json_extract(content, '$.message.usage.input') -
            json_extract(content, '$.message.usage.cacheRead') -
            json_extract(content, '$.message.usage.cacheWrite')
        )
      )
      WHERE role = 'assistant'
        AND json_extract(content, '$.message.usage.total') =
          json_extract(content, '$.message.usage.input') +
          json_extract(content, '$.message.usage.output')
        AND (json_extract(content, '$.message.usage.cacheRead') > 0
          OR json_extract(content, '$.message.usage.cacheWrite') > 0)
    `),
  // Request-shape record: what the model was sent, as far as prompt-cache
  // reuse is concerned. The loop reports every request (ai/agent.ts); only
  // the first request of a session and the ones that changed the head
  // (system prompt or tool schemas) or rewrote the history (compaction,
  // rewind) are stored — the events that cost the provider's cached prefix
  // (see session/request-shapes.ts). Debugging only: nothing reads it
  // during a run, and the row count is proportional to a session's cache
  // breaks, not to its steps.
  (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS request_shapes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        change TEXT NOT NULL,
        head_hash TEXT NOT NULL,
        messages_hash TEXT NOT NULL,
        message_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_request_shapes_session
        ON request_shapes(session_id, id);
    `),
  // stella mode's conversations are hidden from every session list (they are
  // not sessions the user opened — stella has no session concept) while still
  // using the ordinary message store, compaction and rewind.
  //
  // The flag is NOT unique: each stella agent has its own conversation, so
  // several rows carry it at once. The index exists only to make "the stella
  // rows" cheap to find.
  (db) => {
    addColumnIfMissing(db, "sessions", "stella", "INTEGER NOT NULL DEFAULT 0");
    // A database stamped by the earlier, one-conversation shape carries a
    // UNIQUE index here; it would reject the second agent's conversation, so
    // it is replaced rather than kept.
    db.exec("DROP INDEX IF EXISTS idx_sessions_stella");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_stella
        ON sessions(stella);
    `);
  },
  // stella's assistants ("agents"): the other half of "one ongoing
  // conversation with one agent". Each row is a persona — a name and the
  // role it works from — and its conversation is the `sessions` row pointing
  // at it. Terasuma's Tera is the same idea.
  //
  // `sessions.agent_id` is nullable: every pre-existing session (and every
  // code-mode session) has none. The unique index keeps "one conversation per
  // agent" a database fact rather than something the code must remember.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS stella_agents (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        role       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    addColumnIfMissing(db, "sessions", "agent_id", "TEXT");
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_agent
        ON sessions(agent_id) WHERE agent_id IS NOT NULL;
    `);
  },
  // Routines: requests this conversation runs on a schedule. A row belongs
  // to one agent (deleting the agent deletes its routines), and the
  // schedule is one JSON value (three fixed shapes — see shared/routine.ts)
  // rather than three columns of mostly-null fields.
  //
  // A routine's run is an ordinary user message; the message carries the
  // routine's name (see `routine` on UserMessage), so the transcript needs
  // no extra column to tell a scheduled request from a typed one.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS routines (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL REFERENCES stella_agents(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        prompt      TEXT NOT NULL,
        schedule    TEXT NOT NULL,
        enabled     INTEGER NOT NULL,
        next_run_at INTEGER,
        last_run_at INTEGER,
        last_status TEXT,
        last_detail TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_routines_due
        ON routines(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_routines_agent
        ON routines(agent_id, created_at);
    `);
  },
];
