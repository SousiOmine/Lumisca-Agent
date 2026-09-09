import { DatabaseSync } from "node:sqlite";
import { IconMoon, IconPlus, IconSun } from "@tabler/icons-preact";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { assertEquals } from "@std/assert";

/**
 * Stack smoke tests: verify that the external building blocks with no
 * dedicated suite (node:sqlite, tabler icons SSR) work under Deno. These
 * guard against silent incompatibilities when the stack is upgraded.
 *
 * The agent and model-registry scenarios live in their own suites
 * (ai/agent_test.ts, agent/session-agent_test.ts,
 * models/extra-providers_test.ts) — not duplicated here.
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

Deno.test("tabler icons render in Deno (SSR)", () => {
  const html = renderToString(
    createElement(
      "div",
      null,
      createElement(IconPlus, { size: 16 }),
      createElement(IconMoon, { size: 16 }),
      createElement(IconSun, { size: 16 }),
    ),
  );
  if (!html.includes("<svg")) {
    throw new Error(`expected svg output, got: ${html.slice(0, 120)}`);
  }
  if (!html.includes('class="tabler-icon')) {
    throw new Error(`expected tabler-icon class: ${html.slice(0, 200)}`);
  }
});
