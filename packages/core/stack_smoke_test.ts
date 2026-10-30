import { DatabaseSync } from "node:sqlite";
import { assertEquals } from "@std/assert";

/**
 * Stack smoke test: verify that the external building block with no dedicated
 * suite (node:sqlite) works under Deno. It guards against silent
 * incompatibilities when the stack is upgraded.
 *
 * The agent and model-registry scenarios live in their own suites
 * (ai/agent_test.ts, agent/session-agent_test.ts,
 * models/extra-providers_test.ts) — not duplicated here. The tabler icons
 * used to have a case here too; the components that draw them
 * (components/TabBar_test.tsx) render them through the same
 * preact-render-to-string path and assert the `<svg class="tabler-icon">`
 * markup, so a broken icon package fails there first.
 */

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
