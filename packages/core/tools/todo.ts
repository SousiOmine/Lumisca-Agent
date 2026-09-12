import { CoreError } from "../errors.ts";
import type { TodoPhase, TodoStatus } from "../shared/mod.ts";
import { TOOL_TODO } from "../shared/mod.ts";
import type { ClientEvent } from "../types/event.ts";
import {
  array,
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "./schema.ts";

/** The statuses a task can take, in the order the tool accepts them. */
const STATUSES: TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "abandoned",
  "blocked",
];

/** One phase of a plan as the tool receives it. */
export interface TodoPlanInput {
  name: string;
  tasks: Array<{ name: string; status?: TodoStatus }>;
}

/**
 * Owns the todo plan of one session (the `todo` tool): the phases and tasks
 * the agent is working through, with their statuses. Every mutation emits a
 * `todo` event carrying the full plan, so clients can render the progress
 * panel in real time.
 *
 * The plan lives as long as the session is open: it survives agent rebuilds
 * (model/workspace changes) but is discarded when the session closes.
 *
 * The tool replaces the whole plan on every call (DeepSeek Harness's
 * todo_write model) instead of patching single tasks: what the agent sent is
 * exactly what the plan is, with no hidden rewriting behind its back. Ids
 * are therefore matched by name against the previous plan, so a task keeps
 * its id while the work moves through the statuses and the UI panel does not
 * re-key on every update.
 */
export class TodoHub {
  private phases: TodoPhase[] = [];
  /** Id counters, monotonic for the session: an id is never reused, so a
   * client can match a task across plan replacements (and a cleared plan
   * cannot collide with a later one). */
  private nextPhaseId = 1;
  private nextTaskId = 1;

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: ClientEvent) => void,
  ) {}

  /** The current plan (immutable snapshot; mutations replace it). */
  getPlan(): TodoPhase[] {
    return this.phases.map((phase) => ({
      ...phase,
      tasks: phase.tasks.map((task) => ({ ...task })),
    }));
  }

  /** Replace the whole plan. Tasks default to `pending`; ids are inherited
   * from the previous plan where a phase/task of the same name exists, so
   * unchanged entries stay stable across calls. */
  setPlan(input: TodoPlanInput[]): TodoPhase[] {
    const previous = new Map(this.phases.map((phase) => [phase.name, phase]));
    this.phases = input.map((phase) => {
      const before = previous.get(phase.name);
      const taskIds = new Map(
        (before?.tasks ?? []).map((task) => [task.name, task.id]),
      );
      return {
        id: before?.id ?? `p${this.nextPhaseId++}`,
        name: phase.name,
        tasks: phase.tasks.map((task) => ({
          id: taskIds.get(task.name) ?? `t${this.nextTaskId++}`,
          name: task.name,
          status: task.status ?? "pending",
        })),
      };
    });
    return this.announce();
  }

  /** Announce the current plan to clients and return it. */
  private announce(): TodoPhase[] {
    const todos = this.getPlan();
    this.emit({ type: "todo", sessionId: this.sessionId, todos });
    return todos;
  }
}

/** Count tasks by status across the whole plan. */
function countsOf(
  phases: TodoPhase[],
): Record<TodoStatus, number> {
  const counts: Record<TodoStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    abandoned: 0,
    blocked: 0,
  };
  for (const phase of phases) {
    for (const task of phase.tasks) counts[task.status]++;
  }
  return counts;
}

/** The tool result text: what the plan now holds, one count per status the
 * agent uses. Deliberately not the rendered plan — the agent just sent it
 * (it is in the transcript), so echoing it back would only cost tokens. */
export function formatTodoCounts(phases: TodoPhase[]): string {
  const counts = countsOf(phases);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return "Cleared the todo list.";
  const parts = STATUSES.filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${status.replace("_", " ")}`);
  return `Updated todo list: ${parts.join(", ")}.`;
}

const todoSchema = object({
  phases: array(
    object({
      name: string("The phase name (e.g. 調査, 実装, テスト)"),
      tasks: array(
        object({
          name: string("The task"),
          status: optional(string(
            `The task's status: ${STATUSES.join(" | ")} (default: pending)`,
          )),
        }),
        "The tasks of the phase, in order (at least one)",
      ),
    }),
    "The complete plan, in order: every phase with its tasks and their " +
      "current statuses. This replaces the previous plan (there are no " +
      "partial updates). An empty array clears the plan.",
  ),
});

/** Validate a plan and normalize its names (trimmed, no duplicates). */
function normalizePlan(
  phases: Array<
    { name: string; tasks: Array<{ name: string; status?: string }> }
  >,
): TodoPlanInput[] {
  const phaseNames = new Set<string>();
  return phases.map((phase) => {
    const name = phase.name.trim();
    if (name.length === 0) {
      throw new CoreError("Phase names must not be empty", "invalid");
    }
    if (phaseNames.has(name)) {
      throw new CoreError(`Duplicate phase name: ${name}`, "invalid");
    }
    phaseNames.add(name);
    if (phase.tasks.length === 0) {
      throw new CoreError(
        `Phase "${name}" must have at least one task`,
        "invalid",
      );
    }
    const taskNames = new Set<string>();
    const tasks = phase.tasks.map((task) => {
      const taskName = task.name.trim();
      if (taskName.length === 0) {
        throw new CoreError("Task names must not be empty", "invalid");
      }
      if (taskNames.has(taskName)) {
        throw new CoreError(
          `Duplicate task name in phase "${name}": ${taskName}`,
          "invalid",
        );
      }
      taskNames.add(taskName);
      const status = task.status;
      if (status !== undefined && !STATUSES.includes(status as TodoStatus)) {
        throw new CoreError(
          `Unknown status: ${status} (expected ${STATUSES.join(", ")})`,
          "invalid",
        );
      }
      return { name: taskName, status: status as TodoStatus | undefined };
    });
    return { name, tasks };
  });
}

/** Build the tool that records the agent's plan for multi-step work. Each
 * call sends the entire plan and replaces the previous one; the UI shows it
 * in a progress panel, updated live. */
export function createTodoTool(hub: TodoHub): Tool<typeof todoSchema> {
  return {
    name: TOOL_TODO,
    label: "Todo",
    description:
      "Record and update the task list for the current work. Send the " +
      "ENTIRE plan on every call — it REPLACES the previous one (there are " +
      "no partial updates, no per-item edits): each phase with its tasks " +
      "and their statuses. Tasks default to `pending`; the statuses are " +
      "`pending` (not started), `in_progress` (being worked on now), " +
      "`completed` (finished), `abandoned` (dropped on purpose), and " +
      "`blocked` (waiting on something outside the work). An empty `phases` " +
      "array clears the plan. The result reports the resulting counts; the " +
      "user sees the plan live in the UI.",
    parameters: todoSchema,
    execute: (_toolCallId, params): Promise<ToolResult> => {
      const phases = normalizePlan(params.phases ?? []);
      const todos = hub.setPlan(phases);
      return Promise.resolve({
        content: [{ type: "text", text: formatTodoCounts(todos) }],
        details: { todos },
      });
    },
  };
}
