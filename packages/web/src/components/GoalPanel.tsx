import { IconTarget, IconX } from "@tabler/icons-preact";
import type { GoalInfo } from "../types.ts";
import { useT } from "../i18n.ts";
import { CollapsiblePanel } from "./Panel.tsx";

/** The session's active goal (`/goal` mode). Renders nothing while no goal
 * runs; the cancel button stops the autonomous loop. */
export function GoalPanel(
  { goal, onCancel }: { goal?: GoalInfo; onCancel: () => void },
) {
  const t = useT();
  if (goal === undefined) return null;
  const summary = `${goal.iteration}/${goal.maxIterations}${
    goal.status === "judging" ? ` · ${t("panels.goal.judging")}` : ""
  }`;
  return (
    <CollapsiblePanel
      kind="goal-panel"
      icon={<IconTarget size={14} />}
      title={t("panels.goal.title")}
      summary={summary}
    >
      <div className="goal-text" title={goal.text}>{goal.text}</div>
      {goal.lastReason && (
        <div className="goal-reason" title={goal.lastReason}>
          {goal.lastReason}
        </div>
      )}
      <button
        type="button"
        className="goal-cancel"
        title={t("panels.goal.stopTitle")}
        onClick={onCancel}
      >
        <IconX size={12} />
        <span>{t("panels.goal.stop")}</span>
      </button>
    </CollapsiblePanel>
  );
}
