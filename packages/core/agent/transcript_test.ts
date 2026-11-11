import { assertEquals } from "@std/assert";
import type { AgentMessage } from "../ai/types.ts";
import { LumiscaDb } from "../db/mod.ts";
import { createMessageRepo, type MessageRepo } from "../session/messages.ts";
import { TranscriptStore } from "./transcript.ts";

/** A session whose store holds `count` user prompts, 1 ms apart. */
function setup(count: number): { db: LumiscaDb; repo: MessageRepo } {
  const db = LumiscaDb.openInMemory();
  db.db
    .prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('ws', 't', 0)",
    )
    .run();
  db.db
    .prepare(
      `INSERT INTO sessions (id, workspace_id, name, model_provider, model_id, created_at, updated_at)
     VALUES ('s1', 'ws', 't', 'faux', 'model', 0, 0)`,
    )
    .run();
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

/** A checkpoint row. */
function checkpoint(text: string, timestamp: number): AgentMessage {
  return {
    role: "checkpoint",
    title: "t",
    body: text,
    timestamp,
  } as AgentMessage;
}

Deno.test("transcript store: a view loaded from the middle knows where it is", () => {
  const { db, repo } = setup(5);
  try {
    repo.append("s1", checkpoint("summary", 6));
    const store = new TranscriptStore("s1", repo, 1, 5);
    assertEquals(store.baseIndex, 5);
    assertEquals(store.persistedCount, 1);
    assertEquals(store.endIndex, 6);
  } finally {
    db.close();
  }
});

Deno.test("transcript store: an append writes only what is missing", () => {
  const { db, repo } = setup(5);
  try {
    // The view begins at position 2 and holds the 3 rows after it; anything
    // after them is appended from here, and the rows that already exist are
    // not written twice.
    const store = new TranscriptStore("s1", repo, 3, 2);
    const view = repo
      .list("s1")
      .slice(2)
      .map((row) => row.message);
    assertEquals(view.length, 3);
    view.push({ role: "user", content: "new", timestamp: 9 } as AgentMessage);
    store.persist(view);
    assertEquals(repo.count("s1", "all"), 6);
    assertEquals(store.persistedCount, 4);
  } finally {
    db.close();
  }
});

Deno.test("transcript store: an insert translates the view position", () => {
  const { db, repo } = setup(5);
  try {
    // The view begins at position 2; inserting at view position 1 must land
    // at whole-transcript position 3, not at 1.
    const store = new TranscriptStore("s1", repo, 3, 2);
    store.insertAt(1, checkpoint("spliced", 10));
    const roles = repo.list("s1").map((row) => row.role);
    assertEquals(roles, ["user", "user", "user", "checkpoint", "user", "user"]);
  } finally {
    db.close();
  }
});

Deno.test("transcript store: an insertion at the end is counted, not written twice", () => {
  const { db, repo } = setup(3);
  try {
    // The idle compaction appends its checkpoint after the last message: the
    // row is written immediately, so the persisted prefix grows with it.
    const store = new TranscriptStore("s1", repo, 3, 0);
    const view = repo.list("s1").map((row) => row.message);
    store.insertAt(view.length, checkpoint("summary", 4));
    view.push(checkpoint("summary", 4));
    assertEquals(store.persistedCount, 4);
    // The next turn's persist must not write that checkpoint a second time.
    view.push({ role: "user", content: "next", timestamp: 5 } as AgentMessage);
    store.persist(view);
    assertEquals(repo.count("s1", "all"), 5);
    assertEquals(
      repo.list("s1").map((row) => row.role),
      ["user", "user", "user", "checkpoint", "user"],
    );
  } finally {
    db.close();
  }
});

Deno.test("transcript store: a rewind beyond the view re-reads it", () => {
  const { db, repo } = setup(5);
  try {
    repo.append("s1", checkpoint("summary", 6));
    repo.append("s1", {
      role: "user",
      content: "after",
      timestamp: 7,
    } as AgentMessage);
    // The view starts at the checkpoint (position 5) and holds 2 rows.
    const initial = repo.listModelView("s1");
    const store = new TranscriptStore("s1", repo, initial.length, 5);

    // A rewind to the FIRST prompt: everything from position 0 goes, so the
    // view has nothing left to sit on.
    const removed = store.truncateFrom(0);
    assertEquals(removed.length, 7);
    assertEquals(store.reload(), []);
    assertEquals(store.baseIndex, 0);
    assertEquals(repo.count("s1", "all"), 0);
  } finally {
    db.close();
  }
});

Deno.test("transcript store: a rewind inside the view keeps the rows before it", () => {
  const { db, repo } = setup(5);
  try {
    repo.append("s1", checkpoint("summary", 6));
    repo.append("s1", {
      role: "user",
      content: "after",
      timestamp: 7,
    } as AgentMessage);
    const initial = repo.listModelView("s1");
    const store = new TranscriptStore("s1", repo, initial.length, 5);

    // Position 6 is the prompt after the checkpoint: only it (and what
    // follows) goes, so the checkpoint survives as the view's first row.
    const removed = store.truncateFrom(6);
    assertEquals(removed.length, 1);
    assertEquals(
      store.reload().map((m) => m.role),
      ["checkpoint"],
    );
    assertEquals(store.baseIndex, 5);
  } finally {
    db.close();
  }
});
