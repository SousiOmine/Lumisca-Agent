import { CoreError } from "../errors.ts";
import type { TodoPhase, TodoStatus, TodoTask } from "../shared.ts";
import { TOOL_TODO } from "../shared.ts";
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

/** Marker of a task in the text rendering of the plan. */
const STATUS_MARKS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
  abandoned: "[-]",
  blocked: "[!]",
};

/** Count tasks by status across the whole plan. */
function countTasks(phases: TodoPhase[]): number {
  return phases.reduce((n, phase) => n + phase.tasks.length, 0);
}

/**
 * Owns the todo plan of one session (the `todo` tool): the phases and tasks
 * the agent is working through, with their statuses. Every mutation emits a
 * `todo` event carrying the full plan, so clients can render the progress
 * panel in real time.
 *
 * The plan lives as long as the session is open: it survives agent rebuilds
 * (model/workspace changes) but is discarded when the session closes. It is
 * never cleared implicitly — only the agent's `clear` action resets it.
 *
 * Invariants maintained here:
 * - at most one task is `in_progress` at a time (setting a task to
 *   `in_progress` reverts the previous current task to `pending`);
 * - completing a task promotes the first `pending` task of the plan when
 *   no task is `in_progress` afterwards — the usual case is completing
 *   the current task, which covers agents that mark the next task
 *   explicitly too.
 */
export class TodoHub {
  private phases: TodoPhase[] = [];
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

  /** Replace the whole plan with the given phases and tasks. Every task
   * starts `pending`; ids restart at p1 / t1 with each new plan. */
  plan(phases: Array<{ name: string; tasks: string[] }>): TodoPhase[] {
    this.nextPhaseId = 1;
    this.nextTaskId = 1;
    this.phases = phases.map((phase) => ({
      id: `p${this.nextPhaseId++}`,
      name: phase.name,
      tasks: phase.tasks.map((name) => ({
        id: `t${this.nextTaskId++}`,
        name,
        status: "pending",
      })),
    }));
    return this.announce();
  }

  /** Empty the plan. */
  clear(): TodoPhase[] {
    this.phases = [];
    this.nextPhaseId = 1;
    this.nextTaskId = 1;
    return this.announce();
  }

  /** Change one task's status. `phase` and `task` reference the phase and
   * the task by id (p1 / t1) or by name. With `phase` given, the task
   * resolves within that phase only (by id or name, ids scoped to the
   * phase); `phase` may be omitted to resolve a plan-wide task id.
   *
   * Maintaining the invariants: completing a task promotes the first
   * pending task when no task is in_progress afterwards; marking a task
   * `in_progress` demotes the previous current task. */
  update(
    phaseRef: string | undefined,
    taskRef: string,
    status: TodoStatus,
  ): TodoPhase[] {
    const phase = phaseRef === undefined
      ? undefined
      : this.resolvePhase(phaseRef);
    const task = this.resolveTask(phase, taskRef);
    if (task.status === status) {
      // Nothing to change; still announce so clients converge on the same
      // snapshot (the tool call is part of the transcript).
      return this.announce();
    }
    task.status = status;
    if (status === "in_progress") {
      // At most one current task: the previous one goes back to pending.
      for (const other of this.eachTask()) {
        if (other !== task && other.status === "in_progress") {
          other.status = "pending";
        }
      }
    } else if (status === "completed") {
      // The completed task is no longer current (or nothing was current):
      // the first pending task becomes current, if any. When another task
      // is still in_progress it stays the current one.
      const hasCurrent = [...this.eachTask()].some(
        (t) => t.status === "in_progress",
      );
      if (!hasCurrent) {
        for (const candidate of this.eachTask()) {
          if (candidate.status === "pending") {
            candidate.status = "in_progress";
            break;
          }
        }
      }
    }
    return this.announce();
  }

  /** Resolve a phase by id (p1) or by name (unique across the plan, as
   * guaranteed by the plan validation). */
  private resolvePhase(ref: string | undefined): TodoPhase {
    if (ref === undefined) {
      throw new CoreError(
        "todo update requires the phase (id or name) of the task",
        "invalid",
      );
    }
    const byId = this.phases.find((phase) => phase.id === ref);
    if (byId) return byId;
    const byName = this.phases.find((phase) => phase.name === ref);
    if (byName) return byName;
    throw new CoreError(`Unknown phase: ${ref}`, "not_found");
  }

  /** Resolve a task within a phase (id or name; ids are also scoped to the
   * phase when it is given — a phase's task ids are unique plan-wide, but
   * an id from another phase must not match). Without a phase, only ids
   * (unique across the plan) resolve; names need the phase to look in. */
  private resolveTask(phase: TodoPhase | undefined, ref: string): TodoTask {
    if (phase !== undefined) {
      const inPhase = phase.tasks.find(
        (task) => task.id === ref || task.name === ref,
      );
      if (inPhase) return inPhase;
      throw new CoreError(
        `Unknown task: ${ref} (phase "${phase.name}")`,
        "not_found",
      );
    }
    const byId = this.phases
      .flatMap((p) => p.tasks)
      .find((task) => task.id === ref);
    if (byId) return byId;
    throw new CoreError(
      "Unknown task: " +
        `${ref} (the phase is needed to look up task names)`,
      "not_found",
    );
  }

  /** Iterate every task in plan order (phase by phase). */
  private *eachTask(): Generator<TodoTask> {
    for (const phase of this.phases) {
      for (const task of phase.tasks) {
        yield task;
      }
    }
  }

  /** Announce the current plan to clients and return it. */
  private announce(): TodoPhase[] {
    const todos = this.getPlan();
    this.emit({ type: "todo", sessionId: this.sessionId, todos });
    return todos;
  }
}

/** Text rendering of the plan, as seen by the agent. */
export function formatTodo(phases: TodoPhase[]): string {
  if (phases.length === 0) return "Todo: (empty)";
  const total = countTasks(phases);
  const phaseLabel = phases.length === 1 ? "phase" : "phases";
  const taskLabel = total === 1 ? "task" : "tasks";
  const lines = [
    `Todo (${phases.length} ${phaseLabel}, ${total} ${taskLabel}):`,
  ];
  for (const phase of phases) {
    lines.push(`[${phase.name}]`);
    for (const task of phase.tasks) {
      lines.push(
        `  ${STATUS_MARKS[task.status]} ${task.name} (${task.status})`,
      );
    }
  }
  return lines.join("\n");
}

const todoSchema = object({
  action: string(
    'What to do: "plan" (replace the whole plan with `phases`), "list" ' +
      '(return the current plan), "update" (change one task\'s status), or ' +
      '"clear" (empty the plan)',
  ),
  phases: optional(array(
    object({
      name: string("The phase name (e.g. 調査, 実装, テスト)"),
      tasks: array(string("A task name"), "Tasks of the phase (at least one)"),
    }),
    "The new phases (required for action=plan; replaces the whole plan)",
  )),
  phase: optional(string(
    "The phase of the task to update: id (p1) or unique name (action=update)",
  )),
  task: optional(string(
    "The task to update: id (t1) or name, unique within its phase " +
      "(action=update)",
  )),
  status: optional(string(
    "The new status (action=update): pending, in_progress, completed, " +
      "abandoned, or blocked",
  )),
});

/** Build the tool that lets the agent plan and track its work in phases.
 * Each call returns the full current plan; the UI shows it in a progress
 * panel, updated live on every change. Completing the current task
 * (`completed`) auto-advances to the first pending task. */
export function createTodoTool(hub: TodoHub): Tool<typeof todoSchema> {
  return {
    name: TOOL_TODO,
    label: "Todo",
    description:
      "Plan multi-step work and track progress. Tasks are grouped into " +
      "phases; each task has one status: pending, in_progress, completed, " +
      "abandoned, or blocked. Use action=plan to set the whole plan " +
      "(replaces the previous one; all tasks start pending), action=update " +
      "to change a task's status, action=list to view the current plan, " +
      "action=clear to empty it. Completing a task automatically makes the " +
      "first pending task the new current one (when no other task is " +
      "in_progress); at most one task is in_progress at a time. The user " +
      "sees the plan live in the UI, so keep it up to date as you work.",
    parameters: todoSchema,
    execute: (
      _toolCallId,
      params,
      _signal,
    ): Promise<ToolResult> => {
      const action = params.action;
      if (action === "plan") {
        const phases = params.phases ?? [];
        if (phases.length === 0) {
          throw new CoreError(
            "todo plan requires at least one phase",
            "invalid",
          );
        }
        const phaseNames = new Set<string>();
        for (const phase of phases) {
          const name = phase.name.trim();
          if (name.length === 0) {
            throw new CoreError("Phase names must not be empty", "invalid");
          }
          if (phaseNames.has(name)) {
            throw new CoreError(`Duplicate phase name: ${name}`, "invalid");
          }
          phaseNames.add(name);
          const tasks = phase.tasks.map((t) => t.trim());
          if (tasks.length === 0) {
            throw new CoreError(
              `Phase "${name}" must have at least one task`,
              "invalid",
            );
          }
          const taskNames = new Set<string>();
          for (const task of tasks) {
            if (task.length === 0) {
              throw new CoreError("Task names must not be empty", "invalid");
            }
            if (taskNames.has(task)) {
              throw new CoreError(
                `Duplicate task name in phase "${name}": ${task}`,
                "invalid",
              );
            }
            taskNames.add(task);
          }
          // Use the trimmed names for the stored plan.
          (phase as { name: string }).name = name;
          (phase as { tasks: string[] }).tasks = tasks;
        }
        const todos = hub.plan(phases);
        return Promise.resolve({
          content: [{ type: "text", text: formatTodo(todos) }],
          details: { todos },
        });
      }
      if (action === "list") {
        const todos = hub.getPlan();
        return Promise.resolve({
          content: [{ type: "text", text: formatTodo(todos) }],
          details: { todos },
        });
      }
      if (action === "clear") {
        const todos = hub.clear();
        return Promise.resolve({
          content: [{ type: "text", text: formatTodo(todos) }],
          details: { todos },
        });
      }
      if (action === "update") {
        const task = params.task;
        const status = params.status;
        if (task === undefined || status === undefined) {
          throw new CoreError(
            "todo update requires `task` and `status`",
            "invalid",
          );
        }
        if (!STATUSES.includes(status as TodoStatus)) {
          throw new CoreError(
            `Unknown status: ${status} (expected ${STATUSES.join(", ")})`,
            "invalid",
          );
        }
        const todos = hub.update(params.phase, task, status as TodoStatus);
        return Promise.resolve({
          content: [{ type: "text", text: formatTodo(todos) }],
          details: { todos },
        });
      }
      throw new CoreError(
        `Unknown action: ${action} (expected plan, list, update, or clear)`,
        "invalid",
      );
    },
  };
}
