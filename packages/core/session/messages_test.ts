import { assertEquals } from "@std/assert";
import { LumiscaDb } from "../db/mod.ts";
import { createMessageRepo } from "./messages.ts";
import type { AgentMessage } from "@lumisca/core";

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

Deno.test("messages: notification messages round-trip with their fields", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createMessageRepo(db);
    const notification = {
      role: "notification",
      kind: "background",
      title: "[Background command #2 finished after 12s (exit code 0)]",
      body: "listening on :3000",
      status: "success",
      timestamp: 1700000000000,
    } as AgentMessage;
    const stored = repo.append("s1", notification);
    assertEquals(stored.role, "notification");
    assertEquals(stored.message, notification);

    const listed = repo.listMessages("s1");
    assertEquals(listed, [notification]);
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

Deno.test("messages: deleteFrom removes a positional suffix", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createMessageRepo(db);
    // Rows are inserted in transcript order (rowid == position), so
    // deleteFrom cuts the suffix at the given 0-based index. Timestamps
    // are deliberately non-unique: the cut must be positional, not
    // timestamp-based, so messages sharing a millisecond with the
    // boundary are handled exactly.
    for (const timestamp of [100, 100, 200, 200]) {
      repo.append("s1", {
        role: "user",
        content: [{ type: "text", text: `m${timestamp}` }],
        timestamp,
      } as AgentMessage);
    }

    repo.deleteFrom("s1", 2);
    assertEquals(
      repo.list("s1").map((m) => m.timestamp),
      [100, 100],
    );

    // Cutting at 0 empties the session.
    repo.deleteFrom("s1", 0);
    assertEquals(repo.list("s1").length, 0);

    // An index past the last row matches nothing.
    const kept = repo.append("s1", {
      role: "user",
      content: [{ type: "text", text: "keep" }],
      timestamp: 300,
    } as AgentMessage);
    repo.deleteFrom("s1", 10);
    assertEquals(repo.list("s1"), [kept]);

    // Other sessions are unaffected.
    db.db.prepare(
      `INSERT INTO sessions (id, workspace_id, name, model_provider, model_id, created_at, updated_at)
       VALUES ('s2', 'ws1', 'test', 'faux', 'model', 0, 0)`,
    ).run();
    const other = repo.append("s2", {
      role: "user",
      content: [{ type: "text", text: "keep" }],
      timestamp: 500,
    } as AgentMessage);
    repo.deleteFrom("s1", 0);
    assertEquals(repo.list("s2"), [other]);
  } finally {
    db.close();
  }
});

Deno.test("messages: insertAt pushes the rows after the position one later", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createMessageRepo(db);
    const texts = ["a", "b", "c", "d"];
    const ids: string[] = [];
    for (const [i, text] of texts.entries()) {
      ids.push(
        repo.append("s1", {
          role: i % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text }],
          timestamp: 1000 + i,
        } as AgentMessage).id,
      );
    }

    const checkpoint: AgentMessage = {
      role: "checkpoint",
      title: "履歴 2 件を要約しました",
      body: "summary",
      timestamp: 2000,
    } as AgentMessage;
    const inserted = repo.insertAt("s1", 1, checkpoint);

    // The checkpoint took position 1, the rows after it moved one later, and
    // every original row kept its identity and content (the transcript is
    // never rewritten, only pushed).
    const listed = repo.list("s1");
    assertEquals(listed.length, 5);
    assertEquals(listed[0]!.id, ids[0]!);
    assertEquals(listed[1]!.id, inserted.id);
    assertEquals(listed[1]!.message, checkpoint);
    assertEquals(listed.slice(2).map((row) => row.id), ids.slice(1));
    assertEquals(
      listed.slice(2).map((row) =>
        (row.message as { content: Array<{ text: string }> }).content[0]!.text
      ),
      ["b", "c", "d"],
    );
    // The positional operations still agree with the list: truncating from
    // the inserted row leaves exactly the prefix before it.
    repo.deleteFrom("s1", 1);
    assertEquals(repo.list("s1").map((row) => row.id), [ids[0]!]);
  } finally {
    db.close();
  }
});

Deno.test("messages: insertAt appends at or past the last row", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createMessageRepo(db);
    repo.append("s1", sampleMessage());
    const checkpoint: AgentMessage = {
      role: "checkpoint",
      title: "t",
      body: "summary",
      timestamp: 2000,
    } as AgentMessage;

    repo.insertAt("s1", 1, checkpoint);
    repo.insertAt("s1", 99, checkpoint);

    const listed = repo.listMessages("s1");
    assertEquals(listed.length, 3);
    assertEquals(listed[1]!.role, "checkpoint");
    assertEquals(listed[2]!.role, "checkpoint");
  } finally {
    db.close();
  }
});

Deno.test("messages: insertAt leaves other sessions untouched", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    db.db.prepare(
      `INSERT INTO sessions (id, workspace_id, name, model_provider, model_id, created_at, updated_at)
       VALUES ('s2', 'ws1', 'test', 'faux', 'model', 0, 0)`,
    ).run();
    const repo = createMessageRepo(db);
    // Interleaved rows of two sessions share the rowid space: the rewrite
    // must not move (or drop) the other session's rows.
    repo.append("s1", sampleMessage());
    const other = repo.append("s2", sampleMessage());
    repo.append("s1", sampleMessage());

    repo.insertAt("s1", 0, {
      role: "checkpoint",
      title: "t",
      body: "summary",
      timestamp: 2000,
    } as AgentMessage);

    assertEquals(repo.list("s2"), [other]);
    const s1 = repo.listMessages("s1");
    assertEquals(s1.length, 3);
    assertEquals(s1[0]!.role, "checkpoint");
  } finally {
    db.close();
  }
});
