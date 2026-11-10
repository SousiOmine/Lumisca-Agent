import type { SessionAgent } from "../agent/session-agent.ts";
import type { BackgroundCommandInfo } from "../tools/background.ts";
import type { PendingQuestion } from "../tools/ask.ts";
import type { TaskInfo, TodoPhase } from "../shared/mod.ts";
import type { SessionServiceDeps } from "./session-deps.ts";

type Deps = Pick<SessionServiceDeps, "sessions" | "pool">;

/**
 * What a session is doing right now: its agent, its plan, its sub-agents, the
 * commands it has running, the questions and the hand-over it waits on.
 *
 * All of it lives in the pool (the persisted rows only cover the state a
 * reopen can restore), so every read is a snapshot of the live agent; a
 * session that is not open answers empty rather than throwing.
 */
export class SessionState {
  constructor(private readonly deps: Deps) {}

  getAgent(id: string): SessionAgent | undefined {
    return this.deps.pool.get(id);
  }

  getTodo(id: string): TodoPhase[] {
    return this.deps.pool.getTodo(id);
  }

  getTasks(id: string): TaskInfo[] {
    return this.deps.pool.getTasks(id);
  }

  getBackground(id: string): BackgroundCommandInfo[] {
    return this.deps.pool.getBackground(id);
  }

  getPendingQuestions(id: string): PendingQuestion[] {
    return this.deps.pool.getPendingQuestions(id);
  }

  getSessionLastError(id: string): string | undefined {
    return this.deps.pool.lastError(id);
  }
}
