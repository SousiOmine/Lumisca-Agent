import type { LumiscaDb } from "../db/mod.ts";
import type { SubagentStatus, SubagentType } from "../shared/mod.ts";

/**
 * The agents of a session: the row a transcript belongs to.
 *
 * A session owns exactly one `main` agent (the partial unique index makes
 * that a database fact), and any number of `subagent` rows the main agent
 * spawned. Messages point at the agent, not at the session, so the main agent
 * and its sub-agents are read by the same repo, pager, compaction and prune
 * (see session/messages.ts).
 *
 * This repo owns the sub-agent half. A session's main row is written by
 * {@link createSessionRepo} in the same transaction that creates the session:
 * "a session and its main agent" is one fact, and a session without it could
 * never write a message.
 */

/** One sub-agent as the store holds it. */
export interface SubagentRecord {
  id: string;
  sessionId: string;
  /** The agent that spawned it: another sub-agent, or the session's main
   * agent (its id, not the session id). */
  parentAgentId: string;
  type: SubagentType;
  depth: number;
  description: string;
  status: SubagentStatus;
  startedAt: number;
  /** Absent while the run is in flight. */
  finishedAt?: number;
  /** The run's final report; empty until it settles (and for a run that
   * produced no text). */
  resultText: string;
}

/** What a spawn writes: everything except the state a run produces. */
export interface NewSubagent {
  id: string;
  sessionId: string;
  parentAgentId: string;
  type: SubagentType;
  depth: number;
  description: string;
  startedAt: number;
}

export interface AgentRepo {
  /** The id the next sub-agent answers to (`agent_<n>`).
   *
   * Global rather than per session: a message names its agent by this id
   * alone, so two conversations must never mint the same one. The number is
   * read from the rows, which is also what makes it survive a restart; it
   * never goes backwards, because settled rows are kept (only deleting the
   * session removes them).
   *
   * The main agent's id is not minted here: it is opaque and generated with
   * the session (see session/repo.ts), because nothing shows it to anyone. */
  nextSubagentId(): string;
  /** Record a spawned sub-agent. Written before its run starts, so a process
   * that dies mid-run still leaves the task in the store (its row is then
   * settled as aborted on the next open). */
  createSubagent(input: NewSubagent): void;
  /** Write how a run ended. */
  settle(
    id: string,
    status: SubagentStatus,
    finishedAt: number,
    resultText: string,
  ): void;
  /** Settle every sub-agent a dead process left running. A new process has
   * no run behind those rows, so `aborted` is the honest state; leaving them
   * `running` would offer the user a task that can never finish. */
  abortRunning(sessionId: string, at: number): void;
  /** The session's sub-agents, oldest first, at most `limit` of the newest
   * (the same bound the in-memory roster keeps). */
  listSubagents(sessionId: string, limit: number): SubagentRecord[];
}

interface AgentRow {
  id: string;
  parent_id: string | null;
  type: string | null;
  depth: number;
  description: string | null;
  status: string | null;
  started_at: number | null;
  finished_at: number | null;
  /** NOT NULL with an empty default: a run that said nothing reports "". */
  result_text: string;
}

function toSubagent(row: AgentRow, sessionId: string): SubagentRecord {
  // The work fields are NULL only on a main agent's row, and the query never
  // returns one. A NULL here is a row this code did not write: fail loudly
  // rather than invent a task nobody started.
  const {
    parent_id: parentId,
    type,
    description,
    status,
    started_at: startedAt,
  } = row;
  if (
    parentId === null ||
    type === null ||
    description === null ||
    status === null ||
    startedAt === null
  ) {
    throw new Error(`sub-agent row ${row.id} is missing its work fields`);
  }
  return {
    id: row.id,
    sessionId,
    parentAgentId: parentId,
    type: type as SubagentType,
    depth: row.depth,
    description,
    status: status as SubagentStatus,
    startedAt,
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    resultText: row.result_text,
  };
}

export function createAgentRepo(db: LumiscaDb): AgentRepo {
  const insertStmt = db.db.prepare(
    "INSERT INTO agents " +
      "(id, session_id, parent_id, kind, type, depth, description, status, " +
      "started_at, created_at) " +
      "VALUES (?, ?, ?, 'subagent', ?, ?, ?, 'running', ?, ?)",
  );
  const settleStmt = db.db.prepare(
    "UPDATE agents SET status = ?, finished_at = ?, result_text = ? " +
      "WHERE id = ? AND kind = 'subagent'",
  );
  const abortStmt = db.db.prepare(
    "UPDATE agents SET status = 'aborted', finished_at = ? " +
      "WHERE session_id = ? AND kind = 'subagent' AND status = 'running'",
  );
  // The highest number handed out so far. GLOB anchors the pattern to ids
  // this repo mints, so the primary-key range is a short scan whatever else
  // the table holds; CAST reads the suffix past "agent_".
  const nextIdStmt = db.db.prepare(
    "SELECT COALESCE(MAX(CAST(substr(id, 7) AS INTEGER)), 0) AS n " +
      "FROM agents WHERE id GLOB 'agent_[0-9]*'",
  );
  const listStmt = db.db.prepare(
    "SELECT id, parent_id, type, depth, description, status, started_at, " +
      "finished_at, result_text " +
      "FROM agents WHERE session_id = ? AND kind = 'subagent' " +
      "ORDER BY rowid DESC LIMIT ?",
  );

  return {
    nextSubagentId(): string {
      const row = nextIdStmt.get() as { n: number };
      return "agent_" + (Number(row.n) + 1);
    },

    createSubagent(input): void {
      insertStmt.run(
        input.id,
        input.sessionId,
        input.parentAgentId,
        input.type,
        input.depth,
        input.description,
        input.startedAt,
        input.startedAt,
      );
    },

    settle(id, status, finishedAt, resultText): void {
      settleStmt.run(status, finishedAt, resultText, id);
    },

    abortRunning(sessionId, at): void {
      abortStmt.run(at, sessionId);
    },

    listSubagents(sessionId, limit): SubagentRecord[] {
      const rows = listStmt.all(sessionId, limit) as unknown as AgentRow[];
      // The query reads newest first (the bound is on the NEWEST rows); the
      // roster keeps spawn order, oldest first, because eviction and the
      // "newest first" snapshot both work from it.
      return rows.reverse().map((row) => toSubagent(row, sessionId));
    },
  };
}
