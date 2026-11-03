import { assert, assertEquals, assertThrows } from "@std/assert";
import { LumiscaDb } from "../db/mod.ts";
import { CoreError } from "../errors.ts";
import type { AgentMessage } from "../ai/types.ts";
import {
  createMessageRepo,
  type MessageRepo,
  type StoredMessage,
} from "./messages.ts";
import {
  messageCursor,
  type PageRules,
  readTranscriptPage,
  startsTurnRow,
} from "./transcript-pager.ts";

/** A session with `count` user prompts, one millisecond apart. */
function setup(count: number): { db: LumiscaDb; repo: MessageRepo } {
  const db = LumiscaDb.openInMemory();
  db.db.prepare(
    "INSERT INTO workspaces (id, name, created_at) VALUES ('ws', 't', 0)",
  ).run();
  db.db.prepare(
    `INSERT INTO sessions (id, workspace_id, name, model_provider, model_id, created_at, updated_at)
     VALUES ('s1', 'ws', 't', 'faux', 'model', 0, 0)`,
  ).run();
  const repo = createMessageRepo(db);
  for (let i = 1; i <= count; i++) {
    repo.append("s1", {
      role: "user",
      content: `m${i}`,
      timestamp: i,
    } as AgentMessage);
  }
  return { db, repo };
}

/** The code-mode rules: a page is a turn, and the projection drops nothing. */
const RULES = {
  startsWindow: (message: AgentMessage) => startsTurnRow(message),
  project: (row: StoredMessage) => ({
    item: row.timestamp,
    cursor: messageCursor(row.message),
  }),
};

/** Append one assistant turn whose only content is a tool call. */
function toolTurn(repo: MessageRepo, at: number): void {
  repo.append("s1", {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
    api: "openai-completions",
    provider: "faux",
    model: "model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    stopReason: "toolUse",
    timestamp: at,
  } as AgentMessage);
}

Deno.test("transcript pager: the newest page ends at the transcript's end", () => {
  const { db, repo } = setup(5);
  try {
    const page = readTranscriptPage(repo, "s1", { limit: 2 }, RULES);
    assertEquals(page.items, [4, 5]);
    // There is history before it, so the way back is named.
    assert(page.older !== null);
  } finally {
    db.close();
  }
});

Deno.test("transcript pager: the next page ends where the last one began", () => {
  const { db, repo } = setup(5);
  try {
    const newest = readTranscriptPage(repo, "s1", { limit: 2 }, RULES);
    const older = readTranscriptPage(
      repo,
      "s1",
      { limit: 2, older: newest.older! },
      RULES,
    );
    assertEquals(older.items, [2, 3]);
    const oldest = readTranscriptPage(
      repo,
      "s1",
      { limit: 2, older: older.older! },
      RULES,
    );
    assertEquals(oldest.items, [1]);
    // The beginning of the transcript ends the walk: no empty page behind it.
    assertEquals(oldest.older, null);
  } finally {
    db.close();
  }
});

Deno.test("transcript pager: a page pulls its start back to a turn", () => {
  const { db, repo } = setup(1);
  try {
    // One prompt followed by a tool call and three results: those rows
    // belong to the turn the prompt began. A page of 2 that started on a
    // tool result would hand the renderer rows whose prompt it lacks.
    toolTurn(repo, 2);
    for (let i = 0; i < 3; i++) {
      repo.append("s1", {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: `r${i}` }],
        isError: false,
        timestamp: 3 + i,
      } as AgentMessage);
    }

    const page = readTranscriptPage(repo, "s1", { limit: 2 }, RULES);
    // The window grew to cover the whole turn (the prompt is included).
    assertEquals(page.items, [1, 2, 3, 4, 5]);
    assertEquals(page.older, null);
  } finally {
    db.close();
  }
});

Deno.test("transcript pager: a cursor that names nothing is a conflict", () => {
  const { db, repo } = setup(3);
  try {
    assertThrows(
      () =>
        readTranscriptPage(
          repo,
          "s1",
          { limit: 2, older: "no-such-cursor" },
          RULES,
        ),
      CoreError,
    );
  } finally {
    db.close();
  }
});

Deno.test("transcript pager: an invalid page size is refused, not clamped", () => {
  const { db, repo } = setup(3);
  try {
    assertThrows(
      () => readTranscriptPage(repo, "s1", { limit: 0 }, RULES),
      CoreError,
    );
    assertThrows(
      () => readTranscriptPage(repo, "s1", { limit: 1.5 }, RULES),
      CoreError,
    );
  } finally {
    db.close();
  }
});

Deno.test("transcript pager: the page size is bounded", () => {
  const { db, repo } = setup(300);
  try {
    const page = readTranscriptPage(repo, "s1", { limit: 10_000 }, RULES);
    assertEquals(page.items.length, 200);
  } finally {
    db.close();
  }
});

Deno.test("transcript pager: a dropped row still marks the page's turn", () => {
  const { db, repo } = setup(1);
  try {
    // A stella-shaped surface: the projection drops tool traffic, and every
    // entry is its own unit, so the page must not grow to include it.
    toolTurn(repo, 2);
    repo.append("s1", {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "secret" }],
      isError: false,
      timestamp: 3,
    } as AgentMessage);

    const dropped: PageRules<number> = {
      startsWindow: () => true,
      project: (row) =>
        row.role === "toolResult" ? undefined : {
          item: row.timestamp,
          cursor: messageCursor(row.message),
        },
    };
    const page = readTranscriptPage(repo, "s1", { limit: 2 }, dropped);
    // The page is the last two rows; the dropped result is not drawn, but the
    // page still answers a cursor anchored on a row it DID draw (the tool
    // call), so the next read does not land on the same rows again.
    assertEquals(page.items, [2]);
    assert(page.older !== null);
    const older = readTranscriptPage(
      repo,
      "s1",
      { limit: 2, older: page.older! },
      dropped,
    );
    assertEquals(older.items, [1]);
  } finally {
    db.close();
  }
});

Deno.test("transcript pager: a page starts at a checkpoint, not inside it", () => {
  const { db, repo } = setup(2);
  try {
    // A compaction checkpoint is a row of its own in the transcript, so a
    // page that began in the rows after it would draw a "summarized" marker
    // above messages it does not summarize.
    repo.append("s1", {
      role: "checkpoint",
      title: "sum",
      body: "b",
      timestamp: 3,
    } as AgentMessage);
    repo.append("s1", {
      role: "assistant",
      content: [{ type: "text", text: "after" }],
      api: "openai-completions",
      provider: "faux",
      model: "model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
      timestamp: 4,
    } as AgentMessage);

    const page = readTranscriptPage(repo, "s1", { limit: 1 }, RULES);
    // The page pulled its start back to the checkpoint, so the assistant row
    // is served together with the row that opens its turn.
    assertEquals(page.items, [3, 4]);
    // History remains before the checkpoint, so the way back is named by it.
    assertEquals(
      page.older,
      messageCursor({
        role: "checkpoint",
        title: "sum",
        body: "b",
        timestamp: 3,
      } as AgentMessage),
    );
  } finally {
    db.close();
  }
});

Deno.test("transcript pager: the cursor survives a checkpoint inserted before it", () => {
  const { db, repo } = setup(4);
  try {
    const newest = readTranscriptPage(repo, "s1", { limit: 2 }, RULES);
    assertEquals(newest.items, [3, 4]);
    // Compaction inserts a row in the MIDDLE of the transcript, which shifts
    // every later index. A cursor by position would now skip or repeat a
    // message; an identity still names the same one.
    repo.insertAt("s1", 1, {
      role: "checkpoint",
      title: "sum",
      body: "b",
      timestamp: 0,
    } as AgentMessage);
    const older = readTranscriptPage(
      repo,
      "s1",
      { limit: 2, older: newest.older! },
      RULES,
    );
    // The rows before the cursor: the inserted checkpoint and the second
    // prompt. A positional cursor would have landed on the first prompt and
    // repeated it.
    assertEquals(older.items, [0, 2]);
  } finally {
    db.close();
  }
});

Deno.test("transcript pager: an empty transcript has no pages", () => {
  const { db, repo } = setup(0);
  try {
    const page = readTranscriptPage(repo, "s1", { limit: 5 }, RULES);
    assertEquals(page.items, []);
    assertEquals(page.older, null);
  } finally {
    db.close();
  }
});
