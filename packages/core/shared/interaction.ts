/** Frontend-safe shared helpers (see shared/mod.ts): pure functions and constants with no runtime dependencies (no db / pi imports), bundled into the browser client. */

/** One option of an ask question, shown as a selectable chip in the UI. */
export interface AskOption {
  label: string;
  description?: string;
}

/** One question the agent asks the user (the `ask` tool). The UI renders
 * it above the composer together with a free-text field that is always
 * available; the user's answer is returned as the tool result. `multi`
 * (default false) allows several options; `recommended` preselects the
 * option at that index when the question appears. */
export interface AskQuestion {
  id: string;
  question: string;
  options: AskOption[];
  header?: string;
  multi?: boolean;
  recommended?: number;
}

/** The user's answer to one question: the selected option labels and/or
 * the free-text input (`values` holds one entry for single choice,
 * several for multi). Entries that match no option label are the user's
 * free-text answers. */
export interface AskAnswer {
  id: string;
  values: string[];
}

/** State of one todo task (the `todo` tool). `in_progress` is the current
 * task of the plan; at most one task carries it at a time. */
export type TodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "abandoned"
  | "blocked";

/** One task of a todo phase. `id` is stable within the session and
 * assigned by the server when the plan is set (e.g. `t1`, `t2`). */
export interface TodoTask {
  id: string;
  name: string;
  status: TodoStatus;
}

/** One phase of the todo plan: a group of tasks (e.g. 調査・実装・テスト).
 * `id` is stable within the session (e.g. `p1`, `p2`). */
export interface TodoPhase {
  id: string;
  name: string;
  tasks: TodoTask[];
}

/** Kind of sub-agent the `task` tool launches. `explore` is read-only
 * research; `general` carries the full coding tool set. */
export type SubagentType = "explore" | "general";

/** Lifecycle state of one sub-agent task. */
export type SubagentStatus = "running" | "finished" | "failed" | "aborted";

/** Snapshot of one sub-agent task (the `task` tool). Carried by the task
 * events and the tasks resync endpoint, so it lives in the frontend-safe
 * shared module (like the todo plan). */
export interface TaskInfo {
  agentId: string;
  parentAgentId: string;
  subagentType: SubagentType;
  description: string;
  status: SubagentStatus;
  startedAt: number;
  finishedAt?: number;
  /** The final response text (finished states) or the tail of the live
   * response (running). */
  text: string;
}
