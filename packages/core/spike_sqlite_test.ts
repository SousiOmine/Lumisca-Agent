import { DatabaseSync } from "node:sqlite";
import { assertEquals } from "@std/assert";

Deno.test("node:sqlite works in Deno", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT INTO workspaces (name, created_at) VALUES (?, ?)")
    .run("my-workspace", Date.now());
  const row = db.prepare("SELECT name FROM workspaces WHERE id = 1").get() as {
    name: string;
  };
  assertEquals(row.name, "my-workspace");
  db.close();
});
