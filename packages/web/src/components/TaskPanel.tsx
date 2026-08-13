import { useState } from "react";
import { IconChevronDown, IconChevronUp, IconUsers } from "@tabler/icons-react";
import type { TaskView } from "../types.ts";

/** Marker glyph per status, mirroring the task tool's text rendering. */
const STATUS_MARKS: Record<TaskView["status"], string> = {
  running: "▶",
  finished: "✓",
  failed: "✗",
  aborted: "■",
};

/** "N running" while any task runs, otherwise the total count. */
function summary(tasks: TaskView[]): string {
  const running = tasks.filter((t) => t.status === "running").length;
  return running > 0 ? `${running} running` : String(tasks.length);
}

/** The session's sub-agent tasks (the task tool), stacked under the todo
 * panel in the same fixed top-right corner. Renders nothing while no task
 * has been started; the header collapses the body to a compact card. While
 * a task runs, its live response tail is shown (the final report lands in
 * the chat as the tool result or a completion notification). */
export function TaskPanel({ tasks }: { tasks: TaskView[] }) {
  const [collapsed, setCollapsed] = useState(false);
  if (tasks.length === 0) return null;
  return (
    <div className={`task-panel${collapsed ? " collapsed" : ""}`}>
      <button
        type="button"
        className="task-panel-header"
        title={collapsed ? "展開" : "折りたたみ"}
        onClick={() => setCollapsed((c) => !c)}
      >
        <IconUsers size={14} />
        <span className="task-panel-title">Tasks</span>
        <span className="task-panel-summary">{summary(tasks)}</span>
        {collapsed
          ? <IconChevronDown size={14} />
          : <IconChevronUp size={14} />}
      </button>
      {!collapsed && (
        <div className="task-panel-body">
          {tasks.map((task) => (
            <div key={task.agentId} className={`task-item ${task.status}`}>
              <div className="task-head">
                <span className="task-mark">{STATUS_MARKS[task.status]}</span>
                <span className="task-name" title={task.description}>
                  {task.description}
                </span>
                <span className="task-meta" title={task.agentId}>
                  {task.subagentType}
                </span>
              </div>
              {task.status === "running" && task.liveText.length > 0 && (
                <pre className="task-live">{task.liveText.slice(-400)}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
