import { useState } from "preact/compat";
import {
  IconChevronDown,
  IconChevronUp,
  IconTarget,
  IconX,
} from "@tabler/icons-preact";
import type { GoalInfo } from "../types.ts";

/** The session's active goal (`/goal` mode), shown as a rounded panel
 * fixed to the top-right of the chat (same stack as todo/tasks). Renders
 * nothing while no goal runs; the header collapses the body to a compact
 * pill. The cancel button stops the autonomous loop. */
export function GoalPanel(
  { goal, onCancel }: { goal?: GoalInfo; onCancel: () => void },
) {
  const [collapsed, setCollapsed] = useState(false);
  if (goal === undefined) return null;
  const summary = `${goal.iteration}/${goal.maxIterations}${
    goal.status === "judging" ? " · 判定中" : ""
  }`;
  return (
    <div className={`goal-panel${collapsed ? " collapsed" : ""}`}>
      <button
        type="button"
        className="goal-panel-header"
        title={collapsed ? "展開" : "折りたたみ"}
        onClick={() => setCollapsed((c) => !c)}
      >
        <IconTarget size={14} />
        <span className="goal-panel-title">Goal</span>
        <span className="goal-panel-summary">{summary}</span>
        {collapsed
          ? <IconChevronDown size={14} />
          : <IconChevronUp size={14} />}
      </button>
      {!collapsed && (
        <div className="goal-panel-body">
          <div className="goal-text" title={goal.text}>{goal.text}</div>
          {goal.lastReason && (
            <div className="goal-reason" title={goal.lastReason}>
              {goal.lastReason}
            </div>
          )}
          <button
            type="button"
            className="goal-cancel"
            title="ゴールを中断する"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            <IconX size={12} />
            <span>中断</span>
          </button>
        </div>
      )}
    </div>
  );
}
