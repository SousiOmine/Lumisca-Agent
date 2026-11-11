import { assertEquals } from "@std/assert";
import type { AgentMessage } from "../ai/types.ts";
import { LumiscaDb } from "../db/mod.ts";
import { createMessageRepo } from "../session/messages.ts";
import { latestPreview } from "./previews.ts";

/** A workspace + session row, so the messages' foreign keys are satisfied. */
function createSession(db: LumiscaDb, id: string): void {
  db.db
    .prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('ws1', 'test', 0)",
    )
    .run();
  db.db
    .prepare(
      `INSERT INTO sessions (id, workspace_id, name, model_provider, model_id, created_at, updated_at)
     VALUES (?, 'ws1', 'test', 'faux', 'model', 0, 0)`,
    )
    .run(id);
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

Deno.test("latestPreview: a routine's prompt is not what the row says", () => {
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

Deno.test("latestPreview: the run's reply becomes the row again", () => {
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

Deno.test("latestPreview: a routine-only conversation says nothing", () => {
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
