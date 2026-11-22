/**
 * Bringing a session's settled sub-agents back into the roster.
 *
 * A row still marked running belongs to a process that is gone: the hub is
 * built once per open, and nothing of this session can be running in a
 * process that is only now building it. Settling those rows is what keeps the
 * list honest — a task that can never finish must not offer itself as running.
 *
 * This is store work, not hub work, which is why it is here rather than in
 * task-hub.ts: the facade asks for it once, when it is built, and holds
 * nothing of what it reads.
 */
import type { AgentRepo } from "../session/agents.ts";
import type { Subagent } from "./subagent-registry.ts";
import {
  MAX_FINISHED_SUBAGENTS,
  type SubagentRegistry,
} from "./subagent-registry.ts";

/** Restore the session's sub-agents into `roster` as settled rows: they have
 * no run behind them, so their agent, compactor and transcript stay null and
 * the snapshot fields are all that is queryable.
 *
 * Only the newest MAX_FINISHED_SUBAGENTS are loaded, the same bound the
 * roster keeps in memory; the store keeps every row for the read that resumes
 * one. */
export function restoreSubagents(options: {
  agents: AgentRepo;
  sessionId: string;
  roster: SubagentRegistry;
}): void {
  const { agents, sessionId, roster } = options;
  agents.abortRunning(sessionId, Date.now());
  const records = agents.listSubagents(sessionId, MAX_FINISHED_SUBAGENTS);
  for (const record of records) {
    const sub: Subagent = {
      id: record.id,
      parentId: record.parentAgentId,
      type: record.type,
      depth: record.depth,
      description: record.description,
      status: record.status,
      agent: null,
      compactor: null,
      transcript: null,
      startedAt: record.startedAt,
      ...(record.finishedAt !== undefined
        ? { finishedAt: record.finishedAt }
        : {}),
      tail: "",
      resultText: record.resultText,
      unsubscribe: () => {},
      waiters: new Set(),
      abort: new AbortController(),
    };
    roster.add(sub);
  }
}
