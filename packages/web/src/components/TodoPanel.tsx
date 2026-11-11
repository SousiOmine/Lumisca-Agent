import type { MessageKey } from "@lumisca/core/shared";
import { IconListCheck } from "@tabler/icons-preact";
import { useT } from "../i18n.ts";
import type { TodoPhase, TodoStatus, TodoTask } from "../types.ts";
import { CollapsiblePanel } from "./Panel.tsx";

/** Marker glyph per status, mirroring the tool's text rendering. */
const STATUS_MARKS: Record<TodoTask["status"], string> = {
  pending: "○",
  in_progress: "▶",
  completed: "✓",
  abandoned: "—",
  blocked: "⚠",
};

/** The tasks of a plan, in reading order. */
function tasksOf(todos: TodoPhase[]): TodoTask[] {
  return todos.flatMap((p) => p.tasks);
}

/** "done/total": finished work against the whole plan. Abandoned tasks stay
 * counted in the total — they were dropped, not done. */
function summary(todoTasks: TodoTask[]): string {
  const done = todoTasks.filter((t) => t.status === "completed").length;
  return `${done}/${todoTasks.length}`;
}

/** Whether the plan has nothing left to show: every task is finished or was
 * dropped on purpose. The row then leaves the composer alone — an all-done
 * plan is read in the transcript, not above the field. */
function settled(todoTasks: TodoTask[]): boolean {
  return todoTasks.every(
    (t) => t.status === "completed" || t.status === "abandoned",
  );
}

/** The session's todo plan (the todo tool). Renders nothing while the plan
 * is empty or has nothing left to settle. */
export function TodoPanel({ todos }: { todos: TodoPhase[] }) {
  const t = useT();
  const todoTasks = tasksOf(todos);
  if (todoTasks.length === 0 || settled(todoTasks)) return null;
  return (
    <CollapsiblePanel
      kind="todo-panel"
      icon={<IconListCheck size={14} />}
      title={t("panels.todo.title")}
      detail={todoTasks.find((task) => task.status === "in_progress")?.name}
      summary={summary(todoTasks)}
    >
      {todos.map((phase) => (
        <div key={phase.id} className="todo-phase">
          <div className="todo-phase-name">{phase.name}</div>
          <ul className="todo-tasks">
            {phase.tasks.map((task) => (
              <li
                key={task.id}
                className={`todo-task ${task.status}`}
                title={statusLabel(t, task.status)}
              >
                <span className="todo-task-mark">
                  {STATUS_MARKS[task.status]}
                </span>
                <span className="todo-task-name">{task.name}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </CollapsiblePanel>
  );
}

/** The catalogue key of one task status. Spelled out rather than built from
 * the status value: the catalogue test finds callers by their literal key,
 * and a template string would hide every one of these from it. */
function statusLabel(t: ReturnType<typeof useT>, status: TodoStatus): string {
  const keys: Record<TodoStatus, MessageKey> = {
    pending: "panels.todo.status.pending",
    in_progress: "panels.todo.status.in_progress",
    completed: "panels.todo.status.completed",
    abandoned: "panels.todo.status.abandoned",
    blocked: "panels.todo.status.blocked",
  };
  return t(keys[status]);
}
