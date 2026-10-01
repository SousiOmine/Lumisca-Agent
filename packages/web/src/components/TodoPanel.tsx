import { useState } from "preact/compat";
import {
  IconChevronDown,
  IconChevronUp,
  IconListCheck,
} from "@tabler/icons-preact";
import type { TodoPhase, TodoTask } from "../types.ts";
import { useT } from "../i18n.ts";
import { useNarrowViewport } from "../hooks/useMediaQuery.ts";

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

/** The session's todo plan (the todo tool), shown as a rounded panel fixed
 * to the top-right of the chat. Renders nothing while the plan is empty;
 * the header collapses the body to a compact pill. */
export function TodoPanel({ todos }: { todos: TodoPhase[] }) {
  const t = useT();
  // At phone width the panel starts collapsed: the stack sits above the
  // transcript there (side-panels.css), and an expanded body would cover
  // most of what it describes. Only the initial value is taken from the
  // viewport — a later resize must not override the user's own toggle.
  const narrow = useNarrowViewport();
  const [collapsed, setCollapsed] = useState(narrow);
  if (todos.length === 0) return null;
  return (
    <div className={`todo-panel${collapsed ? " collapsed" : ""}`}>
      <button
        type="button"
        className="todo-panel-header"
        title={collapsed
          ? t("common.expandPanel")
          : t("panels.common.collapse")}
        onClick={() => setCollapsed((c) => !c)}
      >
        <IconListCheck size={14} />
        <span className="todo-panel-title">{t("panels.todo.title")}</span>
        <span className="todo-panel-summary">{summary(todos)}</span>
        {collapsed
          ? <IconChevronDown size={14} />
          : <IconChevronUp size={14} />}
      </button>
      {!collapsed && (
        <div className="todo-panel-body">
          {todos.map((phase) => (
            <div key={phase.id} className="todo-phase">
              <div className="todo-phase-name">{phase.name}</div>
              <ul className="todo-tasks">
                {phase.tasks.map((task) => (
                  <li
                    key={task.id}
                    className={`todo-task ${task.status}`}
                    title={task.status}
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
        </div>
      )}
    </div>
  );
}
