import type { Database } from "bun:sqlite";
import { addColumnIfMissing } from "./helpers.ts";

/** Migrations 19 through 23 in schema order. */
export const migrations19to23: ReadonlyArray<(db: Database) => void> = [
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
  // When the user switched this agent off, or NULL while it is on. A
  // timestamp rather than a flag because "off since Tuesday" is a fact the
  // row can answer later, and NULL is the on state — which every existing row
  // is in — so nothing has to be backfilled.
  //
  // A disabled agent is not a hidden one: its conversation stays readable
  // from the store, but nothing about it is built (see stella/agents.ts).
  (db) => addColumnIfMissing(db, "stella_agents", "disabled_at", "INTEGER"),
  // The scripting tool call's store: small JSON values a program keeps across
  // execute calls and session resumes. A table rather than a column on
  // sessions because a program addresses values by key and replaces or
  // deletes one at a time; a JSON blob would rewrite the whole store for
  // every write. The primary key is (session_id, key), so a session's rows
  // are contiguous and no extra index is needed.
  (db) =>
    db.exec(
      "CREATE TABLE IF NOT EXISTS code_store (" +
        "session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, " +
        "key TEXT NOT NULL, " +
        "value TEXT NOT NULL, " +
        "updated_at INTEGER NOT NULL, " +
        "PRIMARY KEY (session_id, key)" +
        ")",
    ),
  // The message store's owner moved from the session to the agent.
  //
  // A session was the only thing that could hold a transcript, so a
  // sub-agent had nowhere to write one: its history lived in memory and died
  // with the run. One row per agent gives the main agent and its sub-agents
  // the same store, pager, compaction and prune; a second message table for
  // sub-agents would duplicate all four and still could not show their work.
  //
  // The main agent row is found by its session, not by an id copied from
  // one: it is the row with kind = 'main', and the partial unique index makes
  // "one main agent per session" a database fact instead of a convention
  // every caller has to remember. A transcript is read through that row,
  // never through the session id.
  //
  // sessions.agent_id moves to persona_id in the same migration. It never
  // pointed at an agent: it points at a stella persona (stella_agents), and
  // two columns named agent_id addressing different tables is a trap a
  // reader cannot see.
  //
  // messages is rebuilt rather than altered: its foreign key has to be
  // retargeted at agents, which SQLite cannot do in place. The copy is an
  // inner join on the session id, so the row count is checked before and
  // after; an orphan, which the old foreign key made impossible, would
  // otherwise vanish without a word.
  (db) => {
    const columnsOf = (table: string): string[] =>
      (
        db.prepare("PRAGMA table_info(" + table + ")").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name);

    // Every step is guarded by the shape it produces, not by the version
    // stamp alone: a database this build already brought here (a replayed
    // migration, or a build that made the change without stamping it) must
    // come out the same instead of having its main agents duplicated or a
    // column renamed twice.
    if (columnsOf("sessions").includes("agent_id")) {
      db.exec("ALTER TABLE sessions RENAME COLUMN agent_id TO persona_id");
      db.exec("DROP INDEX IF EXISTS idx_sessions_agent");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_persona " +
          "ON sessions(persona_id) WHERE persona_id IS NOT NULL",
      );
    }
    db.exec(
      "CREATE TABLE IF NOT EXISTS agents (" +
        "id TEXT PRIMARY KEY, " +
        "session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, " +
        "parent_id TEXT REFERENCES agents(id) ON DELETE CASCADE, " +
        "kind TEXT NOT NULL, " +
        "type TEXT, " +
        "depth INTEGER NOT NULL DEFAULT 0, " +
        "description TEXT, " +
        "status TEXT, " +
        "started_at INTEGER, " +
        "finished_at INTEGER, " +
        "result_text TEXT NOT NULL DEFAULT '', " +
        "created_at INTEGER NOT NULL" +
        ")",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id)",
    );
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_main " +
        "ON agents(session_id) WHERE kind = 'main'",
    );
    // A main agent's id is opaque, like every other id here: nothing derives
    // it from the session, because a row whose id copies another table's id
    // is a second answer to "which agent is this".
    db.exec(
      "INSERT INTO agents (id, session_id, parent_id, kind, depth, created_at) " +
        "SELECT lower(hex(randomblob(16))), s.id, NULL, 'main', 0, s.created_at " +
        "FROM sessions s WHERE NOT EXISTS (" +
        "SELECT 1 FROM agents a " +
        "WHERE a.session_id = s.id AND a.kind = 'main'" +
        ")",
    );
    // A session that already belongs to an agent needs no second rebuild:
    // the rename above may have run again, but the rows are where they go.
    if (columnsOf("messages").includes("agent_id")) return;
    const countRows = (table: string): number => {
      const row = db.prepare("SELECT COUNT(*) AS n FROM " + table).get() as {
        n: number;
      };
      return Number(row.n);
    };
    const before = countRows("messages");
    db.exec(
      "CREATE TABLE messages_rebuilt (" +
        "id TEXT PRIMARY KEY, " +
        "agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, " +
        "role TEXT NOT NULL, " +
        "content TEXT NOT NULL, " +
        "timestamp INTEGER NOT NULL" +
        ")",
    );
    db.exec(
      "INSERT INTO messages_rebuilt (id, agent_id, role, content, timestamp) " +
        "SELECT m.id, a.id, m.role, m.content, m.timestamp " +
        "FROM messages m JOIN agents a ON a.session_id = m.session_id",
    );
    const after = countRows("messages_rebuilt");
    if (before !== after) {
      throw new Error(
        "message migration dropped rows: " +
          before +
          " before, " +
          after +
          " after",
      );
    }
    db.exec("DROP TABLE messages");
    db.exec("ALTER TABLE messages_rebuilt RENAME TO messages");
    db.exec("CREATE INDEX idx_messages_agent ON messages(agent_id, timestamp)");
    db.exec(
      "CREATE INDEX idx_messages_checkpoint " +
        "ON messages(agent_id) WHERE role = 'checkpoint'",
    );
  },
];
