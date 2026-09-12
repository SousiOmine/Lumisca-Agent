import type { DatabaseSync } from "node:sqlite";

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
];

/** The `user_version` a fully migrated database carries: one per migration
 * applied. Exposed so tests assert the invariant ("the stamp matches the
 * migration list") instead of a literal that every new migration breaks. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Apply pending migrations, tracked via PRAGMA user_version. */
export function migrate(db: DatabaseSync): void {
  const { user_version: current } = db
    .prepare("PRAGMA user_version")
    .get() as { user_version: number };
  for (let v = current; v < MIGRATIONS.length; v++) {
    MIGRATIONS[v]!(db);
    db.exec(`PRAGMA user_version = ${v + 1}`);
  }
}
