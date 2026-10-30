import { IconUsers } from "@tabler/icons-preact";
import type { TaskView } from "../types.ts";
import { useT } from "../i18n.ts";
import { CollapsiblePanel } from "./Panel.tsx";

/** The session's running sub-agent tasks (the task tool). A settled task
 * disappears from the panel: its result lands in the chat instead. */
export function TaskPanel({ tasks }: { tasks: TaskView[] }) {
  const t = useT();
  const running = tasks.filter((task) => task.status === "running");
  if (running.length === 0) return null;
  return (
    <CollapsiblePanel
      kind="task-panel"
      icon={<IconUsers size={14} />}
      title={t("panels.task.title")}
      summary={`${running.length} running`}
    >
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
    </CollapsiblePanel>
  );
}
