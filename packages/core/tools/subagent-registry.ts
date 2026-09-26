import type { Agent } from "../ai/agent.ts";
import type { ContextCompactor } from "../agent/context-compaction.ts";
import { CoreError } from "../errors.ts";
import type { SubagentStatus, SubagentType, TaskInfo } from "../shared/mod.ts";

/** Settled sub-agents kept queryable (task_output / resync) per session;
 * older entries are dropped so a long session's metadata stays bounded. */
const MAX_FINISHED_SUBAGENTS = 100;

/** One live sub-agent and its runtime state. `agent` is released (set to
 * null) once the run settles — only the lightweight snapshot fields stay
 * queryable — so finished sub-agents cannot pin their message history in
 * memory for the rest of the session. */
export interface Subagent {
  id: string;
  parentId: string;
  type: SubagentType;
  depth: number;
  description: string;
  status: SubagentStatus;
  agent: Agent | null;
  /** Condenses this sub-agent's history when a request would exceed its
   * model's window (see compactBeforeStep). Per sub-agent so the
   * measurement anchor tracks its own turns. */
  compactor: ContextCompactor;
  startedAt: number;
  finishedAt?: number;
  /** Tail of the current response (bounded; reported while running). */
  tail: string;
  /** Final response text once the run settled. */
  resultText: string;
  unsubscribe: () => void;
  waiters: Set<Waiter>;
  /** Aborts the backoff sleep of a rate-limit retry when the sub-agent is
   * killed or the session closes, so a stop during the wait is not ignored. */
  abort: AbortController;
}

/** A blocking task_output wait on a running sub-agent. */
export interface Waiter {
  /** The agent that issued the wait (used to suppress the completion
   * notification when it receives the result through the tool instead). */
  callerId: string;
  settle: (info: TaskInfo) => void;
  cancel: () => void;
}

/**
 * The roster of one session's sub-agents: the spawned agents (in memory
 * only — nothing is persisted), id resolution, the snapshots task_output
 * and the resync endpoint read, blocking waits on a running agent, and the
 * eviction of settled entries so a long session's metadata stays bounded.
 * The lifecycle stays with the owner (the hub): this roster only holds the
 * agents it was handed.
 */
export class SubagentRegistry {
  private readonly subs = new Map<string, Subagent>();

  /** The session the registered agents belong to. Its id is also the
   * parent agent's id, so it heads the list of known ids. */
  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Register a spawned sub-agent under its id. */
  add(sub: Subagent): void {
    this.subs.set(sub.id, sub);
  }

  /** The sub-agent registered under `id`, if it is still known (settled
   * ones are evicted once a session keeps too many). */
  get(id: string): Subagent | undefined {
    return this.subs.get(id);
  }

  /** Every known sub-agent, in spawn order (oldest first). */
  all(): Iterable<Subagent> {
    return this.subs.values();
  }

  /** Resolve a sub-agent by id, or throw with the list of known ids. */
  require(agentId: string): Subagent {
    const sub = this.subs.get(agentId);
    if (sub === undefined) {
      throw new CoreError(
        `Unknown agent: ${agentId}. Known agents: ${this.knownIds()}`,
        "not_found",
      );
    }
    return sub;
  }

  /** Snapshot of one sub-agent for task_output and the resync endpoint. */
  info(agentId: string): TaskInfo {
    return this.infoOf(this.require(agentId));
  }

  infoOf(sub: Subagent): TaskInfo {
    return {
      agentId: sub.id,
      parentAgentId: sub.parentId,
      subagentType: sub.type,
      description: sub.description,
      status: sub.status,
      startedAt: sub.startedAt,
      ...(sub.finishedAt !== undefined ? { finishedAt: sub.finishedAt } : {}),
      text: sub.status === "running" ? sub.tail : sub.resultText,
    };
  }

  /** Snapshots of every sub-agent, newest first (the tasks resync
   * endpoint; mirrors the todo plan snapshot). */
  list(): TaskInfo[] {
    return [...this.subs.values()].map((sub) => this.infoOf(sub)).reverse();
  }

  private knownIds(): string {
    return [this.sessionId, ...this.subs.keys()].join(", ");
  }

  /** Register a blocking wait on a sub-agent. Resolves when the agent
   * settles, when the timeout elapses (with the current state), or rejects
   * when the caller's run aborts — a torn-down run must never leave a tool
   * hanging. */
  wait(
    agentId: string,
    callerId: string,
    timeoutSec: number,
    signal?: AbortSignal,
  ): Promise<TaskInfo> {
    const sub = this.require(agentId);
    if (sub.status !== "running") return Promise.resolve(this.infoOf(sub));
    if (signal?.aborted) {
      return Promise.reject(
        new CoreError(`Cancelled while waiting for ${agentId}`, "unavailable"),
      );
    }
    return new Promise<TaskInfo>((resolve, reject) => {
      let settled = false;
      const onAbort = () => waiter.cancel();
      const cleanup = () => {
        settled = true;
        sub.waiters.delete(waiter);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter: Waiter = {
        callerId,
        settle: (info) => {
          cleanup();
          resolve(info);
        },
        cancel: () => {
          cleanup();
          reject(
            new CoreError(
              `Cancelled while waiting for ${agentId}`,
              "unavailable",
            ),
          );
        },
      };
      const timer = timeoutSec > 0
        ? setTimeout(() => {
          if (settled) return;
          cleanup();
          resolve(this.infoOf(sub));
        }, timeoutSec * 1000)
        : undefined;
      signal?.addEventListener("abort", onAbort);
      if (signal?.aborted) {
        waiter.cancel();
        return;
      }
      sub.waiters.add(waiter);
    });
  }

  /** Drop the oldest settled sub-agents beyond MAX_FINISHED_SUBAGENTS, so
   * the metadata kept for task_output / resync stays bounded. */
  evictFinished(max = MAX_FINISHED_SUBAGENTS): void {
    if (this.subs.size <= max) return;
    for (const [id, sub] of this.subs) {
      if (sub.status === "running") continue;
      this.subs.delete(id);
      if (this.subs.size <= max) return;
    }
  }
}
