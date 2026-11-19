import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import type { AgentMessage } from "../ai/message.ts";
import { LumiscaDb } from "../db/mod.ts";
import { type AgentRepo, createAgentRepo } from "./agents.ts";
import { createMessageRepo } from "./messages.ts";

/** A workspace, a session and its main agent: what the sub-agent rows hang
 * from. */
function setup(): LumiscaDb {
  const db = LumiscaDb.openInMemory();
  db.db.exec(
    "INSERT INTO workspaces (id, name, created_at) VALUES ('w', 't', 0);" +
      "INSERT INTO sessions " +
      "(id, workspace_id, name, model_provider, model_id, created_at, updated_at) " +
      "VALUES ('s1', 'w', 't', 'faux', 'model', 0, 0);" +
      "INSERT INTO agents (id, session_id, parent_id, kind, depth, created_at) " +
      "VALUES ('main', 's1', NULL, 'main', 0, 0)",
  );
  return db;
}

/** Spawn one row the way the task hub does. */
function spawn(repo: AgentRepo, id: string, description = id): void {
  repo.createSubagent({
    id,
    sessionId: "s1",
    parentAgentId: "main",
    type: "explore",
    depth: 1,
    description,
    startedAt: 1,
  });
}

test("agents: the id counter starts at one and continues from the rows", () => {
  const db = setup();
  try {
    const repo = createAgentRepo(db);
    assertEquals(repo.nextSubagentId(), "agent_1");
    spawn(repo, repo.nextSubagentId());
    assertEquals(repo.nextSubagentId(), "agent_2");
    // The number comes from the rows, so it survives a process that only
    // reads them (a restart) and never hands out a used id.
    spawn(repo, "agent_9");
    assertEquals(repo.nextSubagentId(), "agent_10");
  } finally {
    db.close();
  }
});

test("agents: a settle writes the outcome the roster reports", () => {
  const db = setup();
  try {
    const repo = createAgentRepo(db);
    spawn(repo, "agent_1", "調査");
    repo.settle("agent_1", "finished", 500, "Answer: 42");

    const [row] = repo.listSubagents("s1", 10);
    assertEquals(row?.id, "agent_1");
    assertEquals(row?.parentAgentId, "main");
    assertEquals(row?.type, "explore");
    assertEquals(row?.description, "調査");
    assertEquals(row?.status, "finished");
    assertEquals(row?.finishedAt, 500);
    assertEquals(row?.resultText, "Answer: 42");
  } finally {
    db.close();
  }
});

test("agents: the list keeps the newest rows, oldest first", () => {
  const db = setup();
  try {
    const repo = createAgentRepo(db);
    for (const id of ["agent_1", "agent_2", "agent_3"]) spawn(repo, id);
    assertEquals(
      repo.listSubagents("s1", 2).map((row) => row.id),
      ["agent_2", "agent_3"],
    );
  } finally {
    db.close();
  }
});

test("agents: a row left running is settled as aborted", () => {
  const db = setup();
  try {
    const repo = createAgentRepo(db);
    spawn(repo, "agent_1");
    repo.settle("agent_1", "finished", 10, "done");
    spawn(repo, "agent_2");

    repo.abortRunning("s1", 900);

    const rows = repo.listSubagents("s1", 10);
    assertEquals(rows[0]?.status, "finished");
    assertEquals(rows[1]?.status, "aborted");
    assertEquals(rows[1]?.finishedAt, 900);
  } finally {
    db.close();
  }
});

test("agents: deleting the session takes its sub-agents and their messages", () => {
  const db = setup();
  try {
    const repo = createAgentRepo(db);
    const messages = createMessageRepo(db);
    spawn(repo, "agent_1");
    messages.append("agent_1", {
      role: "user",
      content: "hello",
      timestamp: 1,
    } as AgentMessage);

    db.db.exec("DELETE FROM sessions WHERE id = 's1'");

    assertEquals(repo.listSubagents("s1", 10), []);
    assertEquals(messages.list("agent_1"), []);
  } finally {
    db.close();
  }
});
