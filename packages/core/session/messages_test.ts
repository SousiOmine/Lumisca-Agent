import { assertEquals } from "@std/assert";
import { LumiscaDb } from "../db/mod.ts";
import { createMessageRepo } from "./messages.ts";
import type { AgentMessage, ImageContent, ModeMessage } from "@lumisca/core";

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

Deno.test("messages: mode rows written before the images field decode as imageless", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    // A v1 row: mode messages did not carry `images` yet (the shape is the
    // current one minus that field). Decoding must fill the field instead
    // of leaving it undefined — the UI renders that array and
    // toLlmMessages spreads it into the request.
    const modeMessage: Omit<ModeMessage, "images"> = {
      role: "mode",
      modeId: "plan",
      optionId: "",
      modeLabel: "プラン作成モード",
      shortText: "履歴機能を追加して",
      fullPrompt: "あなたは実装プランナーです。…",
      timestamp: 1700000000000,
    };
    const insert = db.db.prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(
      "v1-1",
      "s1",
      "mode",
      JSON.stringify({ v: 1, message: modeMessage }),
      modeMessage.timestamp,
    );
    // The legacy (pre-stamping) form has the same shape as v1.
    insert.run(
      "legacy-1",
      "s1",
      "mode",
      JSON.stringify(modeMessage),
      modeMessage.timestamp,
    );

    const repo = createMessageRepo(db);
    assertEquals(repo.listMessages("s1"), [
      { ...modeMessage, images: [] },
      { ...modeMessage, images: [] },
    ]);

    // A current row keeps the images it was stored with.
    const image: ImageContent = {
      type: "image",
      data: "QUJD",
      mimeType: "image/png",
    };
    const withImage: ModeMessage = {
      ...modeMessage,
      images: [image],
      timestamp: modeMessage.timestamp + 1,
    };
    repo.append("s1", withImage);
    assertEquals(repo.listMessages("s1").at(-1), withImage);
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

Deno.test("messages: listBetween bounds the window and keeps transcript order", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createMessageRepo(db);
    const at = (timestamp: number) =>
      repo.append("s1", {
        role: "user",
        content: `t${timestamp}`,
        timestamp,
      } as AgentMessage);

    // Inserted out of order: the window is by timestamp, the order is the
    // transcript's (rowid).
    at(3000);
    at(1000);
    at(2000);

    const all = repo.listBetween("s1", { from: null, to: null });
    assertEquals(all.map((row) => row.timestamp), [3000, 1000, 2000]);
    // Both bounds are inclusive.
    assertEquals(
      repo.listBetween("s1", { from: 2000, to: 3000 }).map((row) =>
        row.timestamp
      ),
      [3000, 2000],
    );
    // One open side each way.
    assertEquals(
      repo.listBetween("s1", { from: 2000, to: null }).map((row) =>
        row.timestamp
      ),
      [3000, 2000],
    );
    assertEquals(
      repo.listBetween("s1", { from: null, to: 2000 }).map((row) =>
        row.timestamp
      ),
      [1000, 2000],
    );
    assertEquals(repo.listBetween("s1", { from: 4000, to: null }), []);
  } finally {
    db.close();
  }
});

Deno.test("messages: listModelView starts at the newest checkpoint", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createMessageRepo(db);
    const at = (role: string, text: string, timestamp: number) =>
      repo.append("s1", {
        role,
        ...(role === "checkpoint"
          ? { title: "t", body: text }
          : { content: text }),
        timestamp,
      } as AgentMessage);

    at("user", "before", 1);
    at("checkpoint", "first summary", 2);
    at("user", "middle", 3);
    at("checkpoint", "second summary", 4);
    at("user", "after", 5);

    // The model sees the NEWEST checkpoint and what follows it; the rest is
    // the conversation's history, kept but not loaded.
    assertEquals(
      repo.listModelView("s1").map((row) => row.timestamp),
      [4, 5],
    );
  } finally {
    db.close();
  }
});

Deno.test("messages: listModelView returns the whole transcript when never compacted", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createMessageRepo(db);
    for (let i = 1; i <= 3; i++) {
      repo.append("s1", {
        role: "user",
        content: `m${i}`,
        timestamp: i,
      } as AgentMessage);
    }
    assertEquals(
      repo.listModelView("s1").map((row) => row.timestamp),
      [1, 2, 3],
    );
  } finally {
    db.close();
  }
});

Deno.test("messages: listWindow pages backwards, oldest first", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createMessageRepo(db);
    for (let i = 1; i <= 5; i++) {
      repo.append("s1", {
        role: "user",
        content: `m${i}`,
        timestamp: i,
      } as AgentMessage);
    }

    const newest = repo.listWindow("s1", { beforeIndex: null, limit: 2 });
    assertEquals(newest.map((row) => row.timestamp), [4, 5]);

    // The page before it, ending where the previous one started (row 4's
    // position is 3 — rows are 0-based positions in transcript order).
    const older = repo.listWindow("s1", { beforeIndex: 3, limit: 2 });
    assertEquals(older.map((row) => row.timestamp), [2, 3]);

    const oldest = repo.listWindow("s1", { beforeIndex: 1, limit: 2 });
    assertEquals(oldest.map((row) => row.timestamp), [1]);

    // Before the first row there is nothing, not an error.
    assertEquals(repo.listWindow("s1", { beforeIndex: 0, limit: 2 }), []);
  } finally {
    db.close();
  }
});

Deno.test("messages: listWindow never reads another session's rows", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    db.db.prepare(
      `INSERT INTO sessions (id, workspace_id, name, model_provider, model_id, created_at, updated_at)
       VALUES ('s2', 'ws1', 'test', 'faux', 'model', 0, 0)`,
    ).run();
    const repo = createMessageRepo(db);
    repo.append("s1", {
      role: "user",
      content: "mine",
      timestamp: 1,
    } as AgentMessage);
    repo.append("s2", {
      role: "user",
      content: "theirs",
      timestamp: 2,
    } as AgentMessage);

    const page = repo.listWindow("s1", { beforeIndex: null, limit: 10 });
    assertEquals(page.map((row) => row.timestamp), [1]);
  } finally {
    db.close();
  }
});

Deno.test("messages: pruneCondensed reduces only what a checkpoint covers", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createMessageRepo(db);
    repo.append("s1", {
      role: "user",
      content: "first question",
      timestamp: 1,
    } as AgentMessage);
    repo.append("s1", {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: "a lot of output" }],
      isError: false,
      timestamp: 2,
    } as AgentMessage);
    repo.append("s1", {
      role: "checkpoint",
      title: "t",
      body: "summary",
      timestamp: 3,
    } as AgentMessage);
    repo.append("s1", {
      role: "toolResult",
      toolCallId: "c2",
      toolName: "bash",
      content: [{ type: "text", text: "recent output" }],
      isError: false,
      timestamp: 4,
    } as AgentMessage);

    const reducedOnce = repo.pruneCondensed("s1");
    assertEquals(reducedOnce.changed, 1);
    // The bytes it freed are what a caller uses to notice the file is worth
    // rewriting (see db/vacuum.ts). A marker can be longer than the payload
    // it replaces for a very short output, and that is reported honestly as
    // zero rather than as a negative saving.
    assertEquals(reducedOnce.freedBytes >= 0, true);
    const rows = repo.list("s1");
    // The user's words are untouched, and so is anything after the
    // checkpoint (the model still reads that part).
    assertEquals(
      (rows[0]!.message as { content: string }).content,
      "first question",
    );
    assertEquals(
      (rows[3]!.message as { content: Array<{ text: string }> }).content[0]!
        .text,
      "recent output",
    );
    // The covered tool result is a marker now, and it kept its identity.
    const reduced = rows[1]!.message;
    assertEquals(reduced.role, "toolResult");
    if (reduced.role === "toolResult") {
      assertEquals(reduced.toolCallId, "c1");
      assertEquals(reduced.content[0]!.type === "text", true);
    }
    // Reducing again is a no-op: the marker is already what it would write.
    const again = repo.pruneCondensed("s1");
    assertEquals(again.changed, 0);
    assertEquals(again.freedBytes, 0);
    // The row count never changes: positions are transcript order, and a
    // hole would move every row after it.
    assertEquals(repo.count("s1"), 4);
  } finally {
    db.close();
  }
});

Deno.test("messages: usageRows reads every assistant usage in the store", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createMessageRepo(db);
    for (const at of [1, 2]) {
      repo.append("s1", {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        api: "openai-completions",
        provider: "faux",
        model: "model",
        usage: { input: at, output: 1, cacheRead: 10 * at, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: at,
      } as AgentMessage);
    }
    const rows = repo.usageRows("s1");
    assertEquals(rows.length, 2);
    assertEquals(rows[1]!.usage?.input, 2);
    assertEquals(rows[1]!.usage?.cacheRead, 20);
  } finally {
    db.close();
  }
});

Deno.test("messages: newestConversationRows reads only what a conversation shows", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createMessageRepo(db);
    // Transcript order: prompt, the agent's turn, its tool traffic, the
    // message it SENT, a failed send, what the user said next.
    repo.append("s1", {
      role: "user",
      content: [{ type: "text", text: "直して" }],
      timestamp: 100,
    } as AgentMessage);
    repo.append("s1", {
      role: "assistant",
      content: [{ type: "text", text: "作業メモ" }],
      api: "openai-completions",
      provider: "faux",
      model: "faux-1",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
      timestamp: 110,
    } as AgentMessage);
    repo.append("s1", {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 120,
    } as AgentMessage);
    repo.append("s1", {
      role: "toolResult",
      toolCallId: "call-2",
      toolName: "send_chat",
      content: [{ type: "text", text: "Sent the message." }],
      isError: false,
      timestamp: 130,
    } as AgentMessage);
    repo.append("s1", {
      role: "toolResult",
      toolCallId: "call-3",
      toolName: "send_chat",
      content: [{ type: "text", text: "failed" }],
      isError: true,
      timestamp: 140,
    } as AgentMessage);
    repo.append("s1", {
      role: "user",
      content: [{ type: "text", text: "ありがとう" }],
      timestamp: 150,
    } as AgentMessage);

    const rows = repo.newestConversationRows("s1", 10);
    // Newest first, and only the two prompts plus the successful send: the
    // agent's own text, a tool's output and a failed send are not things the
    // conversation shows.
    assertEquals(
      rows.map((row) => [row.role, row.timestamp]),
      [["user", 150], ["toolResult", 130], ["user", 100]],
    );

    // The limit bounds the read (it is a payload bound, not a scan).
    assertEquals(repo.newestConversationRows("s1", 2).length, 2);

    // Another session's rows never appear.
    db.db.prepare(
      `INSERT INTO sessions (id, workspace_id, name, model_provider, model_id, created_at, updated_at)
       VALUES ('s2', 'ws1', 'test', 'faux', 'model', 0, 0)`,
    ).run();
    repo.append("s2", {
      role: "user",
      content: [{ type: "text", text: "other" }],
      timestamp: 900,
    } as AgentMessage);
    assertEquals(repo.newestConversationRows("s1", 10).length, 3);
  } finally {
    db.close();
  }
});

Deno.test("messages: newestConversationRows also reads pre-stamped rows", () => {
  // The store holds two envelopes, and decodeStoredMessage reads both. A
  // filter that understood only the current one would leave an older
  // conversation's last message invisible in the sidebar while the
  // conversation itself showed it.
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const legacy: AgentMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "send_chat",
      content: [{ type: "text", text: "Sent." }],
      isError: false,
      timestamp: 100,
    };
    db.db.prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp) " +
        "VALUES (?, ?, ?, ?, ?)",
    ).run(
      "legacy-1",
      "s1",
      "toolResult",
      JSON.stringify(legacy),
      legacy.timestamp,
    );
    const repo = createMessageRepo(db);
    // It comes back from the query AND decodes to the same message, so the
    // projection can read it.
    const rows = repo.newestConversationRows("s1", 4);
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.message, legacy);
  } finally {
    db.close();
  }
});
