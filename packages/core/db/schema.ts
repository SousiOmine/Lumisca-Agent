import type { DatabaseSync } from "node:sqlite";

/**
 * `ALTER TABLE … ADD COLUMN`, skipped when the column already exists.
 *
 * Two shapes of database reach this: the ordinary one (the column is
 * missing) and one written by an older build that added the column without
 * stamping the version — those exist in the wild, and a retried migration
 * must not fail on them. With migrations now transactional (see
 * {@link applyMigrations}) this guards history, not the current path.
 */
function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_folders (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  PRIMARY KEY (workspace_id, path)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  system_prompt TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
`;

/** Ordered schema migrations. Index i brings the DB from user_version i to
 * i+1; appending a new migration is the only thing needed to evolve the
 * schema of existing databases. */
const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  (db) => db.exec(BASE_SCHEMA),
  // Distinguish custom (user-provided) system prompts from generated ones:
  // generated prompts are rebuilt from the workspace (including AGENTS.md)
  // whenever a session is opened, so project memory edits take effect.
  (db) =>
    db.exec(
      "ALTER TABLE sessions ADD COLUMN system_prompt_custom INTEGER NOT NULL DEFAULT 0",
    ),
  // Settings moved out of the database into ~/.config/lumisca-agent/settings.jsonc.
  (db) => db.exec("DROP TABLE IF EXISTS settings"),
  // Custom system prompts were removed: sessions always use the generated
  // prompt, snapshotted at creation. Drop the distinguishing flag.
  (db) => db.exec("ALTER TABLE sessions DROP COLUMN system_prompt_custom"),
  // Chat workspaces (folder-less "simple chat" mode): a flag distinguishes
  // them from coding workspaces so sessions created without a workspace can
  // still satisfy the workspace_id foreign key.
  (db) =>
    db.exec(
      "ALTER TABLE workspaces ADD COLUMN chat INTEGER NOT NULL DEFAULT 0",
    ),
  // Goal mode (the `/goal` autonomous loop): one active goal per session.
  // goal_text NULL means no active goal; the remaining columns carry the
  // loop progress shown in the right-side panel.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN goal_text TEXT");
    db.exec(
      "ALTER TABLE sessions ADD COLUMN goal_iteration INTEGER NOT NULL DEFAULT 0",
    );
    db.exec(
      "ALTER TABLE sessions ADD COLUMN goal_max_iterations INTEGER NOT NULL DEFAULT 10",
    );
    db.exec("ALTER TABLE sessions ADD COLUMN goal_status TEXT");
    db.exec("ALTER TABLE sessions ADD COLUMN goal_last_reason TEXT");
  },
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
    addColumnIfMissing(
      db,
      "sessions",
      "stella",
      "INTEGER NOT NULL DEFAULT 0",
    );
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
  // Each stella agent's identity: the text it writes about itself — its role,
  // what it is responsible for, and the knowledge the work needs. It is
  // separate from `role` (which the USER wrote at creation and never changes):
  // this one is the agent's own, written by the `identity` tool.
  //
  // Stored rather than derived because it outlives any one session row and
  // has no file to live in: the machine's home is reachable from every agent,
  // and a persona is a property of the agent, not of a folder.
  (db) => {
    addColumnIfMissing(
      db,
      "stella_agents",
      "identity",
      "TEXT NOT NULL DEFAULT ''",
    );
  },
];

/** The `user_version` a fully migrated database carries: one per migration
 * applied. Exposed so tests assert the invariant ("the stamp matches the
 * migration list") instead of a literal that every new migration breaks. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Apply pending migrations, tracked via PRAGMA user_version.
 *
 * Each migration runs in its own transaction WITH its stamp, so a process
 * killed mid-migration leaves the database at the previous version instead
 * of half-migrated. That matters because the ALTERs are not idempotent: a
 * column added without its stamp would make the retried migration fail with
 * `duplicate column name`, and the database could never be opened again. */
export function migrate(db: DatabaseSync): void {
  applyMigrations(db, MIGRATIONS);
}

/** Apply a migration list. Split from {@link migrate} so a test can drive a
 * deliberately failing migration and observe the rollback, which is the
 * property that keeps a half-done database openable. */
export function applyMigrations(
  db: DatabaseSync,
  migrations: ReadonlyArray<(db: DatabaseSync) => void>,
): void {
  const { user_version: current } = db
    .prepare("PRAGMA user_version")
    .get() as { user_version: number };
  for (let v = current; v < migrations.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migrations[v]!(db);
      // PRAGMA user_version cannot take a bound parameter, and the value is
      // this module's own integer (never user input).
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
