import { useState } from "react";
import { IconChevronDown, IconChevronUp, IconUsers } from "@tabler/icons-react";
import type { TaskView } from "../types.ts";

/** The session's sub-agent tasks (the task tool), stacked under the todo
 * panel in the same fixed top-right corner. Shows only the tasks that are
 * still running — a finished, failed, or aborted task disappears from the
 * panel the moment it settles (its completion lands in the chat as the
 * tool result or a completion notification). Renders nothing while no task
 * runs; the header collapses the body to a compact card. */
export function TaskPanel({ tasks }: { tasks: TaskView[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const running = tasks.filter((t) => t.status === "running");
  if (running.length === 0) return null;
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
        <span className="task-panel-summary">{running.length} running</span>
        {collapsed
          ? <IconChevronDown size={14} />
          : <IconChevronUp size={14} />}
      </button>
      {!collapsed && (
        <div className="task-panel-body">
          {running.map((task) => (
            <div key={task.agentId} className="task-item">
              <div className="task-head">
                <span className="task-mark">▶</span>
                <span className="task-name" title={task.description}>
                  {task.description}
                </span>
                <span className="task-meta" title={task.agentId}>
                  {task.subagentType}
                </span>
              </div>
              {task.liveText.length > 0 && (
                <pre className="task-live">{task.liveText.slice(-400)}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
