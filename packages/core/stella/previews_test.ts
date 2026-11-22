import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { LumiscaDb } from "../db/mod.ts";
import type { AgentMessage } from "../domain/message.ts";
import { createMessageRepo } from "../session/messages.ts";
import { latestPreview } from "./previews.ts";

/** The workspace, session and agent rows the messages' foreign keys need.
 * The key the tests use is the AGENT id: a message belongs to an agent. */
function createSession(db: LumiscaDb, id: string): void {
  db.db
    .prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('ws1', 'test', 0)",
    )
    .run();
  db.db
    .prepare(
      "INSERT INTO sessions " +
        "(id, workspace_id, name, model_provider, model_id, created_at, updated_at) " +
        "VALUES (?, 'ws1', 'test', 'faux', 'model', 0, 0)",
    )
    .run("session-" + id);
  db.db
    .prepare(
      "INSERT INTO agents (id, session_id, parent_id, kind, depth, created_at) " +
        "VALUES (?, ?, NULL, 'main', 0, 0)",
    )
    .run(id, "session-" + id);
}

function userMessage(
  text: string,
  timestamp: number,
  routine?: string,
): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
    ...(routine === undefined ? {} : { routine }),
  } as AgentMessage;
}

function assistantMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

test("latestPreview: a routine's prompt is not what the row says", () => {
  // Regression: the row named the routine ("ルーチン「…」") although the
  // conversation hides the prompt, so the list showed a message that was
  // not in the conversation. The row now steps back to the newest entry the
  // conversation actually draws.
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createMessageRepo(db);
    repo.append("s1", userMessage("おはよう", 1_000));
    repo.append("s1", assistantMessage("おはようございます。", 2_000));
    repo.append(
      "s1",
      userMessage("毎朝デプロイを確認して", 3_000, "朝のデプロイ確認"),
    );
    assertEquals(latestPreview(repo, "s1"), {
      kind: "text",
      text: "おはようございます。",
      at: 2_000,
    });
  } finally {
    db.close();
  }
});

test("latestPreview: the run's reply becomes the row again", () => {
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createMessageRepo(db);
    repo.append("s1", userMessage("おはよう", 1_000));
    repo.append(
      "s1",
      userMessage("毎朝デプロイを確認して", 2_000, "朝のデプロイ確認"),
    );
    repo.append("s1", assistantMessage("異常はありません。", 3_000));
    assertEquals(latestPreview(repo, "s1"), {
      kind: "text",
      text: "異常はありません。",
      at: 3_000,
    });
  } finally {
    db.close();
  }
});

test("latestPreview: a routine-only conversation says nothing", () => {
  // The prompt is the only thing in the conversation, and it is invisible:
  // an honest row has no second line rather than quoting the instruction.
  const db = LumiscaDb.openInMemory();
  try {
    createSession(db, "s1");
    const repo = createMessageRepo(db);
    repo.append(
      "s1",
      userMessage("毎朝デプロイを確認して", 1_000, "朝のデプロイ確認"),
    );
    assertEquals(latestPreview(repo, "s1"), null);
    // A conversation that does not exist yet has nothing either.
    assertEquals(latestPreview(repo, undefined), null);
  } finally {
    db.close();
  }
});
