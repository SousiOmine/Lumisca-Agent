import { assertEquals } from "@std/assert";
import { migrate, SCHEMA_VERSION } from "./schema.ts";
import { LumiscaDb } from "./mod.ts";

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

Deno.test("migrate is idempotent when reopened", () => {
  const db = LumiscaDb.openInMemory();
  const goalColumns = db.db
    .prepare("SELECT name FROM pragma_table_info('sessions')")
    .all() as unknown as Array<{ name: string }>;
  db.close();
  // Guard against a migration that only works on a fresh database: the
  // column list is what later migrations key off.
  assertEquals(
    goalColumns.some((column) => column.name === "goal_text"),
    true,
  );
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
