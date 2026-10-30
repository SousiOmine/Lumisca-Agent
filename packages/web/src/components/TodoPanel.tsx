import { IconListCheck } from "@tabler/icons-preact";
import type { TodoPhase, TodoStatus, TodoTask } from "../types.ts";
import { useT } from "../i18n.ts";
import type { MessageKey } from "@lumisca/core/shared";
import { CollapsiblePanel } from "./Panel.tsx";

/** Marker glyph per status, mirroring the tool's text rendering. */
const STATUS_MARKS: Record<TodoTask["status"], string> = {
  pending: "○",
  in_progress: "▶",
  completed: "✓",
  abandoned: "—",
  blocked: "⚠",
};

/** "done/total" summary across the whole plan. */
function summary(todos: TodoPhase[]): string {
  const tasks = todos.flatMap((p) => p.tasks);
  const done = tasks.filter((t) => t.status === "completed").length;
  return `${done}/${tasks.length}`;
}

/** The session's todo plan (the todo tool). Renders nothing while the plan
 * is empty. */
export function TodoPanel({ todos }: { todos: TodoPhase[] }) {
  const t = useT();
  if (todos.length === 0) return null;
  return (
    <CollapsiblePanel
      kind="todo-panel"
      icon={<IconListCheck size={14} />}
      title={t("panels.todo.title")}
      summary={summary(todos)}
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
function statusLabel(
  t: ReturnType<typeof useT>,
  status: TodoStatus,
): string {
  const keys: Record<TodoStatus, MessageKey> = {
    pending: "panels.todo.status.pending",
    in_progress: "panels.todo.status.in_progress",
    completed: "panels.todo.status.completed",
    abandoned: "panels.todo.status.abandoned",
    blocked: "panels.todo.status.blocked",
  };
  return t(keys[status]);
}
