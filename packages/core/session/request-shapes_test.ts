import { assertEquals } from "@std/assert";
import { LumiscaDb } from "../db/mod.ts";
import { createRequestShapeRepo } from "./request-shapes.ts";
import type { RequestShape } from "../ai/types.ts";

/** Create workspace + session rows so the FK constraint is satisfied. */
function createSession(db: LumiscaDb, id: string): void {
  db.db.prepare(
    "INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES ('ws1', 'test', 0)",
  ).run();
  db.db.prepare(
    `INSERT INTO sessions (id, workspace_id, name, model_provider, model_id, created_at, updated_at)
     VALUES (?, 'ws1', 'test', 'faux', 'model', 0, 0)`,
  ).run(id);
}

function shape(overrides: Partial<RequestShape> = {}): RequestShape {
  return {
    headHash: "abc",
    messagesHash: "def",
    messageCount: 2,
    change: "initial",
    ...overrides,
  };
}

Deno.test("request shapes: record/list round-trips a session's cache breaks", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    createSession(db, "s2");
    const repo = createRequestShapeRepo(db);

    repo.record("s1", shape(), 1000);
    repo.record("s1", shape({ change: "head-changed", headHash: "xyz" }), 2000);
    repo.record(
      "s1",
      shape({ change: "history-rewritten", messageCount: 9 }),
      3000,
    );
    repo.record("s2", shape({ change: "head-changed" }), 1500);

    const s1 = repo.list("s1");
    assertEquals(s1.length, 3);
    assertEquals(
      s1.map((r) => r.change),
      ["initial", "head-changed", "history-rewritten"],
    );
    assertEquals(s1.map((r) => r.createdAt), [1000, 2000, 3000]);
    assertEquals(s1[1]!.headHash, "xyz");
    assertEquals(s1[2]!.messageCount, 9);
    assertEquals(s1[0]!.sessionId, "s1");

    // Sessions are isolated.
    assertEquals(repo.list("s2").length, 1);
    assertEquals(repo.list("unknown"), []);
  } finally {
    db.close();
  }
});

Deno.test("request shapes: a limit keeps the newest entries", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createRequestShapeRepo(db);
    for (let i = 0; i < 5; i++) {
      repo.record("s1", shape({ change: "head-changed" }), 1000 + i);
    }
    const newest = repo.list("s1", 2);
    assertEquals(newest.length, 2);
    assertEquals(newest.map((r) => r.createdAt), [1003, 1004]);
  } finally {
    db.close();
  }
});

Deno.test("request shapes: an append-extension is stored without a change reason", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createRequestShapeRepo(db);
    // The loop reports every request; a caller may store an extension too.
    // Its row then says so rather than claiming a cache break.
    repo.record("s1", { headHash: "h", messagesHash: "m", messageCount: 3 });
    assertEquals(repo.list("s1")[0]!.change, "append");
  } finally {
    db.close();
  }
});

Deno.test("request shapes: deleting a session cascades to its rows", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createRequestShapeRepo(db);
    repo.record("s1", shape());
    db.db.prepare("DELETE FROM sessions WHERE id = 's1'").run();
    assertEquals(repo.list("s1"), []);
  } finally {
    db.close();
  }
});
