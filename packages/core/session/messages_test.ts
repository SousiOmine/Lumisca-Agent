import { assertEquals } from "@std/assert";
import { LumiscaDb } from "../db/mod.ts";
import { createMessageRepo } from "./messages.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

function sampleMessage(): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: 1234567890,
  } as AgentMessage;
}

/** Create workspace + session rows so the messages FK constraint is
 * satisfied. */
function createSession(db: LumiscaDb, id: string): void {
  db.db.prepare(
    "INSERT INTO workspaces (id, name, created_at) VALUES ('ws1', 'test', 0)",
  ).run();
  db.db.prepare(
    `INSERT INTO sessions (id, workspace_id, name, model_provider, model_id, created_at, updated_at)
     VALUES (?, 'ws1', 'test', 'faux', 'model', 0, 0)`,
  ).run(id);
}

Deno.test("messages: append/list round-trips through the versioned envelope", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createMessageRepo(db);
    const message = sampleMessage();
    const stored = repo.append("s1", message);
    assertEquals(stored.message, message);

    const listed = repo.list("s1");
    assertEquals(listed.length, 1);
    assertEquals(listed[0]!.message, message);
    assertEquals(repo.listMessages("s1"), [message]);
  } finally {
    db.close();
  }
});

Deno.test("messages: legacy rows (raw AgentMessage JSON) still decode", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    // Simulate a row written before versioning: raw AgentMessage JSON.
    const message = sampleMessage();
    db.db.prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "legacy-1",
      "s1",
      "user",
      JSON.stringify(message),
      message.timestamp as number,
    );

    const repo = createMessageRepo(db);
    const listed = repo.list("s1");
    assertEquals(listed.length, 1);
    assertEquals(listed[0]!.message, message);
  } finally {
    db.close();
  }
});
