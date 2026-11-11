import type { Database } from "bun:sqlite";

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
  db: Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
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
 * schema of existing databases. Exported for the test that applies all but
 * the last one, inserts a row, and checks what the last one does to it. */
export const MIGRATIONS: ReadonlyArray<(db: Database) => void> = [
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
  // Each stella agent's icon: the picture the USER picked for it, as a name
  // the icon store generated (the file sits beside the database, like the
  // visuals and the attachments). Empty means "no picture yet" — the row is
  // then drawn as the name's initial on a colour derived from the id
  // (shared/agent-avatar.ts), so the default needs no column.
  //
  // A name rather than a path: the store generates every name, so a message
  // or a database row can never point the icon route at a file of its own
  // choosing.
  (db) => {
    addColumnIfMissing(db, "stella_agents", "icon", "TEXT NOT NULL DEFAULT ''");
  },
  // Opening a session loads what the MODEL is shown — the newest compaction
  // checkpoint and everything after it — rather than the whole transcript
  // (a conversation that runs for years holds more than any request can
  // carry, and none of it needs to be in memory to draw the screen: pages are
  // read from the store). Finding that checkpoint is one descending scan, and
  // this PARTIAL index is what keeps it cheap however long the conversation
  // grows: only checkpoint rows are indexed, and they sit in rowid order
  // within a session (rowid is the index's implicit last key), so the newest
  // one is the last entry of the session's range.
  (db) =>
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_checkpoint
        ON messages(session_id) WHERE role = 'checkpoint';
    `),
  // A `watch` routine's last observation, so the next check has something to
  // compare against. JSON, like `schedule`: the three sources observe
  // different things and a column per field would be mostly null. NULL means
  // "never checked" (or the state was lost), and the next check is a
  // baseline — it records and does not fire (see vm/watch.ts).
  (db) => addColumnIfMissing(db, "routines", "watch_state", "TEXT"),
  // Each stella agent's own model: the pair its conversation runs on, chosen
  // beside the name and the picture. NULL in both columns means "use the
  // app's default model" — the state a new agent starts in, and what a user
  // returns to by clearing the choice. The conversation still stores the
  // pair it runs on (`sessions`), so this is the user's intent and that row
  // is what the run uses; the edit dialog writes both in one call.
  (db) => {
    addColumnIfMissing(db, "stella_agents", "model_provider", "TEXT");
    addColumnIfMissing(db, "stella_agents", "model_id", "TEXT");
  },
  // What a `watch` routine's CHECKS did, kept apart from what its RUNS did.
  // A check is not a run: it makes no inference call and produces no answer,
  // so writing it into `last_run_at` / `last_status` made the settings list
  // say "failed a moment ago" about a routine that had never run, and made a
  // machine that is down look like a routine that keeps failing. NULL means
  // nothing was checked yet / the last check answered.
  (db) => {
    addColumnIfMissing(db, "routines", "watch_checked_at", "INTEGER");
    addColumnIfMissing(db, "routines", "watch_error", "TEXT");
  },
  // When the app started an agent's setup turn (see stella/onboarding.ts).
  // NULL means it has not started yet; the turn is started from the
  // conversation's first open and marked here so a reload, a second client
  // or a routine can never start a second one.
  //
  // Existing agents are stamped with their creation time: they were made
  // before conversations had a setup turn, and a user who has been talking
  // to one for weeks must not be greeted with "let's set me up" the next
  // time they open it. A NULL column is therefore only ever a NEW agent.
  (db) => {
    addColumnIfMissing(db, "stella_agents", "onboarded_at", "INTEGER");
    db.exec(
      "UPDATE stella_agents SET onboarded_at = created_at " +
        "WHERE onboarded_at IS NULL",
    );
  },
  // `sessions` with one column per fact, which needs a rebuilt table: SQLite
  // cannot add a reference or drop a column's constraint in place. Three
  // leftovers go at once, because each answers the same question — what does
  // a session row have to say for itself?
  //
  // - `stella` repeated what `agent_id` already said. The agent link is the
  //   fact; a stella conversation is one that has one. The two columns could
  //   disagree, and a row carrying only the flag (the single-conversation
  //   era) was invisible to the session lists AND to every agent.
  // - The goal-mode columns (`goal_text` …) outlived the feature. Nothing
  //   reads them, so a reader of the table has to learn that they are dead.
  // - `agent_id` had no reference, so a row could name an agent that is gone.
  //
  // Before the rebuild, a conversation with no agent to own it gets one,
  // named after the conversation. That keeps its history reachable — in the
  // sidebar, as an agent — instead of leaving it where neither list nor any
  // agent could see it. Migrations run with foreign keys off (see
  // applyMigrations), so every row this touches is written explicitly.
  (db) => {
    const orphans = db
      .prepare(
        "SELECT s.id, s.name, s.created_at, s.updated_at FROM sessions s " +
          "LEFT JOIN stella_agents a ON a.id = s.agent_id " +
          "WHERE a.id IS NULL AND (s.stella = 1 OR s.agent_id IS NOT NULL)",
      )
      .all() as Array<{
      id: string;
      name: string;
      created_at: number;
      updated_at: number;
    }>;
    const insertAgent = db.prepare(
      "INSERT INTO stella_agents " +
        "(id, name, role, identity, icon, onboarded_at, created_at, updated_at) " +
        "VALUES (?, ?, '', '', '', ?, ?, ?)",
    );
    const adopt = db.prepare("UPDATE sessions SET agent_id = ? WHERE id = ?");
    for (const row of orphans) {
      const id = crypto.randomUUID();
      // Stamped as already set up: this agent has been talking to the user
      // for longer than this build has existed, and a setup turn now would
      // introduce it to someone who already knows it.
      insertAgent.run(
        id,
        row.name.trim() || "Stella",
        row.created_at,
        row.created_at,
        row.updated_at,
      );
      adopt.run(id, row.id);
    }
    // A stella conversation has no name of its own (see SessionRepo): the
    // column held a copy, and a rename had to chase it.
    db.exec("UPDATE sessions SET name = '' WHERE agent_id IS NOT NULL");
    db.exec(`
      CREATE TABLE sessions_rebuilt (
        id             TEXT PRIMARY KEY,
        workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name           TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        model_id       TEXT NOT NULL,
        system_prompt  TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        agent_id       TEXT REFERENCES stella_agents(id)
      );
      INSERT INTO sessions_rebuilt
        (id, workspace_id, name, model_provider, model_id, system_prompt,
         created_at, updated_at, agent_id)
        SELECT id, workspace_id, name, model_provider, model_id, system_prompt,
               created_at, updated_at, agent_id
        FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_rebuilt RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS idx_sessions_workspace
        ON sessions(workspace_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_agent
        ON sessions(agent_id) WHERE agent_id IS NOT NULL;
    `);
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
export function migrate(db: Database): void {
  applyMigrations(db, MIGRATIONS);
}

/** A migration that would leave a row pointing at a row that is not there
 * fails here, before its stamp is written. */
function assertForeignKeys(db: Database): void {
  const violations = db.prepare("PRAGMA foreign_key_check").all() as Array<{
    table: string;
    rowid: number;
    parent: string;
  }>;
  const first = violations[0];
  if (first === undefined) return;
  throw new Error(
    `migration left a dangling reference: ${first.table} row ${first.rowid} → ${first.parent}`,
  );
}

/** Apply a migration list. Split from {@link migrate} so a test can drive a
 * deliberately failing migration and observe the rollback, which is the
 * property that keeps a half-done database openable. */
export function applyMigrations(
  db: Database,
  migrations: ReadonlyArray<(db: Database) => void>,
): void {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  // Foreign keys are off for the run, and every step is checked before its
  // commit. A table rebuild (the only way to add a reference or drop a
  // constraint in SQLite) would otherwise cascade into the child rows when
  // the old table is dropped — a transcript's messages go with it — and a
  // rebuild that would leave a row pointing at nothing rolls back instead of
  // landing. The check is what keeps the promise the old `foreign_keys = ON`
  // made: a migration cannot commit a broken reference.
  const { foreign_keys: wasEnabled } = db
    .prepare("PRAGMA foreign_keys")
    .get() as { foreign_keys: number };
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (let v = current; v < migrations.length; v++) {
      db.exec("BEGIN IMMEDIATE");
      try {
        migrations[v]!(db);
        assertForeignKeys(db);
        // PRAGMA user_version cannot take a bound parameter, and the value is
        // this module's own integer (never user input).
        db.exec(`PRAGMA user_version = ${v + 1}`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  } finally {
    if (wasEnabled === 1) db.exec("PRAGMA foreign_keys = ON");
  }
}
