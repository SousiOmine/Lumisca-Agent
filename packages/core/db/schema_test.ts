import { Database } from "bun:sqlite";
import { assert, assertEquals } from "@std/assert";
import { LumiscaDb } from "./mod.ts";
import {
  applyMigrations,
  MIGRATIONS,
  migrate,
  SCHEMA_VERSION,
} from "./schema.ts";

Deno.test("migrate brings an empty database to the newest user_version", () => {
  const db = LumiscaDb.openInMemory();
  try {
    const [current] = db.db
      .prepare("PRAGMA user_version")
      .all() as unknown as Array<{ user_version: number }>;
    assertEquals(current?.user_version, SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

Deno.test("migrate adds the session workspace index", () => {
  const db = LumiscaDb.openInMemory();
  try {
    const rows = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as unknown as Array<{ name: string }>;
    const names = rows.map((row) => row.name);
    // listByWorkspace filters on workspace_id on every session list.
    assertEquals(names.includes("idx_sessions_workspace"), true);
    assertEquals(names.includes("idx_messages_session"), true);
  } finally {
    db.close();
  }
});

/** user_version one below the context-usage conversion (append-only list
 * position 7): replaying the migration over a database stamped there is
 * what an existing installation does on its first launch after the fix. */
const PRE_USAGE_FIX_VERSION = 7;

/** Store assistant rows with the given `usage` objects (the envelope the
 * message repo writes). The workspace/session rows satisfy the foreign
 * keys. */
function insertAssistantRows(
  db: LumiscaDb,
  usages: Array<Record<string, number>>,
): void {
  db.db.exec(`
    INSERT INTO workspaces (id, name, created_at, chat) VALUES ('w', 'w', 0, 0);
    INSERT INTO sessions (id, workspace_id, name, model_provider, model_id, created_at, updated_at)
      VALUES ('s', 'w', 's', 'opencode-go', 'm', 0, 0);
  `);
  const stmt = db.db.prepare(
    "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, 's', 'assistant', ?, 0)",
  );
  usages.forEach((usage, index) => {
    stmt.run(
      `m${index}`,
      JSON.stringify({ v: 1, message: { role: "assistant", usage } }),
    );
  });
}

/** The `usage` objects as they are stored now, in insert order. */
function storedUsages(
  db: LumiscaDb,
): Array<Record<string, number> | undefined> {
  const rows = db.db
    .prepare("SELECT content FROM messages ORDER BY rowid")
    .all() as unknown as Array<{ content: string }>;
  return rows.map((row) => {
    const parsed = JSON.parse(row.content) as {
      message: { usage?: Record<string, number> };
    };
    return parsed.message.usage;
  });
}

Deno.test("migrate turns a double-counted prompt into its uncached part", () => {
  const db = LumiscaDb.openInMemory();
  try {
    insertAssistantRows(db, [
      // A row as the transport used to write it: `input` holds the whole
      // prompt (cached reads included) and `total` is prompt + completion.
      {
        input: 43591,
        output: 1202,
        cacheRead: 42496,
        cacheWrite: 0,
        total: 44793,
      },
      // Same convention without a cache: nothing to correct.
      { input: 7947, output: 149, cacheRead: 0, cacheWrite: 0, total: 8096 },
      // Cache writes (Anthropic-style providers) are cached prompt tokens too.
      {
        input: 10000,
        output: 100,
        cacheRead: 2000,
        cacheWrite: 3000,
        total: 10100,
      },
    ]);
    db.db.exec(`PRAGMA user_version = ${PRE_USAGE_FIX_VERSION}`);
    migrate(db.db);

    assertEquals(storedUsages(db), [
      {
        input: 1095,
        output: 1202,
        cacheRead: 42496,
        cacheWrite: 0,
        total: 44793,
      },
      { input: 7947, output: 149, cacheRead: 0, cacheWrite: 0, total: 8096 },
      {
        input: 5000,
        output: 100,
        cacheRead: 2000,
        cacheWrite: 3000,
        total: 10100,
      },
    ]);
  } finally {
    db.close();
  }
});

Deno.test("migrate leaves rows that already report an uncached prompt alone", () => {
  const db = LumiscaDb.openInMemory();
  try {
    insertAssistantRows(db, [
      // Correct row: `total` is prompt + completion (summing the split
      // parts), so `total` is not `input + output` anymore.
      {
        input: 1095,
        output: 1202,
        cacheRead: 42496,
        cacheWrite: 0,
        total: 44793,
      },
      // Row from the transport before the rewrite (its own field names).
      {
        input: 175,
        output: 2887,
        cacheRead: 84992,
        cacheWrite: 0,
        totalTokens: 88054,
      },
      // A failure placeholder: no tokens reported.
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ]);
    const before = storedUsages(db);
    db.db.exec(`PRAGMA user_version = ${PRE_USAGE_FIX_VERSION}`);
    migrate(db.db);

    assertEquals(storedUsages(db), before);
  } finally {
    db.close();
  }
});

Deno.test("a failing migration rolls back together with its stamp", () => {
  // A killed process between an ALTER and its stamp used to leave a column
  // without the version, and the retried migration then failed with
  // `duplicate column name` — the database could never be opened again.
  // Each step now runs in one transaction with its stamp.
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");
    const version = () =>
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
    const columns = () =>
      (
        db
          .prepare("SELECT name FROM pragma_table_info('workspaces')")
          .all() as unknown as Array<{ name: string }>
      ).map((column) => column.name);

    let ran = 0;
    const migrations: Array<(db: Database) => void> = [
      (target) => {
        ran++;
        target.exec(
          "ALTER TABLE workspaces ADD COLUMN chat INTEGER NOT NULL DEFAULT 0",
        );
      },
      (target) => {
        ran++;
        // Fails: the column exists. The step must not leave a partial
        // schema behind with a stale version.
        target.exec(
          "ALTER TABLE workspaces ADD COLUMN chat INTEGER NOT NULL DEFAULT 0",
        );
      },
    ];
    let failure: unknown;
    try {
      applyMigrations(db, migrations);
    } catch (error) {
      failure = error;
    }
    assert(failure !== undefined, "the second migration must fail");
    assertEquals(ran, 2, "both migrations ran");
    // The first one committed (its column and stamp stand); the second
    // rolled back completely, so a retry can run it again.
    assertEquals(version(), 1);
    assertEquals(columns().filter((name) => name === "chat").length, 1);
  } finally {
    db.close();
  }
});

/** user_version one below the setup-turn migration (append-only list
 * position 18): a database from before conversations had a setup turn. Named
 * rather than "the last one", so appending a migration does not quietly
 * change what this test is about. */
const PRE_ONBOARDING_VERSION = 18;

Deno.test("migrate stamps existing agents as already set up", () => {
  const db = new Database(":memory:");
  try {
    // A database from before the setup turn: every row it holds belongs to
    // someone who has been talking to that agent, and none of them may be
    // greeted with "let's set me up" on the next open.
    applyMigrations(db, MIGRATIONS.slice(0, PRE_ONBOARDING_VERSION));
    db.exec(
      "INSERT INTO stella_agents (id, name, role, created_at, updated_at) " +
        "VALUES ('a1', 'Aide', 'r', 111, 222)",
    );
    applyMigrations(db, MIGRATIONS);
    const existing = db
      .prepare("SELECT onboarded_at FROM stella_agents WHERE id = 'a1'")
      .get() as { onboarded_at: number | null };
    assertEquals(existing.onboarded_at, 111);

    // A row made after the migration has not been set up: it is the only
    // kind that may start the turn.
    db.exec(
      "INSERT INTO stella_agents (id, name, role, created_at, updated_at) " +
        "VALUES ('a2', 'New', 'r', 333, 333)",
    );
    const fresh = db
      .prepare("SELECT onboarded_at FROM stella_agents WHERE id = 'a2'")
      .get() as { onboarded_at: number | null };
    assertEquals(fresh.onboarded_at, null);
  } finally {
    db.close();
  }
});

/** user_version one below the session-table rebuild (append-only list
 * position 19). */
const PRE_SESSION_REBUILD_VERSION = 19;

/** Insert a message row that satisfies the rebuild's references; the payload
 * is never read by it, but a real row is what must survive the table swap. */
function insertMessages(db: Database, sessionId: string, ids: string[]): void {
  const stmt = db.prepare(
    "INSERT INTO messages (id, session_id, role, content, timestamp) " +
      "VALUES (?, ?, 'user', ?, 1)",
  );
  for (const id of ids) {
    stmt.run(id, sessionId, `{"v":2,"message":{"role":"user","content":"hi"}}`);
  }
}

Deno.test("migrate rebuilds sessions: one column per fact, children kept", () => {
  const db = new Database(":memory:");
  try {
    applyMigrations(db, MIGRATIONS.slice(0, PRE_SESSION_REBUILD_VERSION));
    db.exec(`
      INSERT INTO workspaces (id, name, created_at, chat)
        VALUES ('w', 'W', 0, 0);
      INSERT INTO stella_agents (id, name, role, created_at, updated_at)
        VALUES ('a1', 'Aide', 'r', 0, 0);
      INSERT INTO sessions
        (id, workspace_id, name, model_provider, model_id, created_at,
         updated_at, stella, agent_id)
        VALUES
          ('plain',  'w', 'Build failed',     'faux', 'm', 0, 0, 0, NULL),
          ('conv',   'w', 'Aide',             'faux', 'm', 0, 0, 1, 'a1'),
          ('legacy', 'w', 'Old conversation', 'faux', 'm', 0, 0, 1, NULL),
          ('ghost',  'w', '',                 'faux', 'm', 0, 0, 1, 'gone');
    `);
    for (const id of ["plain", "conv", "legacy", "ghost"]) {
      insertMessages(db, id, [`m-${id}-1`, `m-${id}-2`]);
    }
    db.exec(`
      INSERT INTO request_shapes
        (session_id, created_at, change, head_hash, messages_hash, message_count)
        VALUES ('conv', 0, 'first', 'h', 'm', 0), ('legacy', 0, 'first', 'h', 'm', 0);
    `);

    applyMigrations(db, MIGRATIONS);

    // The derived column and the dead feature's columns are gone.
    const columns = (
      db
        .prepare("SELECT name FROM pragma_table_info('sessions')")
        .all() as Array<{ name: string }>
    ).map((column) => column.name);
    assertEquals(columns.includes("stella"), false);
    assertEquals(columns.includes("goal_text"), false);
    assertEquals(columns.includes("goal_status"), false);

    // A conversation that belongs to an agent has no name of its own.
    const names = db
      .prepare("SELECT id, name, agent_id FROM sessions ORDER BY id")
      .all() as Array<{ id: string; name: string; agent_id: string | null }>;
    assertEquals(names.find((row) => row.id === "conv")?.name, "");
    assertEquals(names.find((row) => row.id === "plain")?.name, "Build failed");

    // The two conversations with no agent to own them were adopted instead
    // of being left unreachable, and the agent is named after each.
    const adopted = db
      .prepare("SELECT id, name FROM stella_agents ORDER BY created_at, rowid")
      .all() as Array<{ id: string; name: string }>;
    assertEquals(adopted.length, 3);
    assertEquals(
      adopted.some((agent) => agent.name === "Old conversation"),
      true,
    );
    // A row pointing at an agent that is not there was given one too.
    assertEquals(
      adopted.some((agent) => agent.name === "Stella"),
      true,
    );
    for (const row of names) {
      assertEquals(row.agent_id === null, row.id === "plain");
    }

    // The rebuild drops the old table; every child row is still there.
    const messages = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as {
      n: number;
    };
    assertEquals(Number(messages.n), 8);
    // The debug table references sessions too, and keeps its rows.
    const shapes = db
      .prepare("SELECT COUNT(*) AS n FROM request_shapes")
      .get() as { n: number };
    assertEquals(Number(shapes.n), 2);

    // The reference is now the database's business: a row cannot name an
    // agent that does not exist.
    db.exec("PRAGMA foreign_keys = ON");
    let refused = false;
    try {
      db.exec(
        "INSERT INTO sessions (id, workspace_id, name, model_provider, " +
          "model_id, created_at, updated_at, agent_id) " +
          "VALUES ('bad', 'w', '', 'faux', 'm', 0, 0, 'gone')",
      );
    } catch {
      refused = true;
    }
    assertEquals(refused, true);
  } finally {
    db.close();
  }
});

Deno.test("a migration that would commit a dangling reference is refused", () => {
  // Migrations run with foreign keys off (a table rebuild needs that), so
  // the check before the commit is what keeps "a migration cannot land a
  // broken reference" true.
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES parent(id)
      );
      INSERT INTO parent (id) VALUES ('p');
      INSERT INTO child (id, parent_id) VALUES ('c', 'p');
    `);
    const version = () =>
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
    const rows = () =>
      Number(
        (
          db.prepare("SELECT COUNT(*) AS n FROM child").get() as {
            n: number;
          }
        ).n,
      );

    let failure: unknown;
    try {
      applyMigrations(db, [
        (target) =>
          target.exec("INSERT INTO child (id, parent_id) VALUES ('d', 'gone')"),
      ]);
    } catch (error) {
      failure = error;
    }
    assert(failure !== undefined, "the migration must be refused");
    assert(
      String(failure).includes("dangling"),
      `unexpected error: ${String(failure)}`,
    );
    // Rolled back with its stamp: nothing landed, so a fixed retry can run.
    assertEquals(version(), 0);
    assertEquals(rows(), 1);
  } finally {
    db.close();
  }
});
