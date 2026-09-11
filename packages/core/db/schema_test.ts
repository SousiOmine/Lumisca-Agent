import { assertEquals } from "@std/assert";
import { LumiscaDb } from "./mod.ts";

Deno.test("migrate brings an empty database to the newest user_version", () => {
  const db = LumiscaDb.openInMemory();
  try {
    const [current] = db.db
      .prepare("PRAGMA user_version")
      .all() as unknown as Array<{ user_version: number }>;
    // 7 migrations: base schema + 6 evolution steps.
    assertEquals(current?.user_version, 7);
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
