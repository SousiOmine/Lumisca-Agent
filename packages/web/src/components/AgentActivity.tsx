import { useEffect, useState } from "preact/compat";
import { IconChevronRight, IconLoader2 } from "@tabler/icons-preact";
import { useT } from "../i18n.ts";

/** Format elapsed milliseconds as "Xm Ys" or "Ys". */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hour = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (hour > 0) return `${hour}h ${min}m ${sec}s`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

interface AgentActivityProps {
  startedAt: number;
  endedAt?: number;
  running: boolean;
  expanded: boolean;
  expandable: boolean;
  onToggle: () => void;
}

/**
 * One turn's work summary. While the agent is running it acts as a live
 * timer; after completion it toggles the intermediate messages and tools.
 */
export function AgentActivity({
  startedAt,
  endedAt,
  running,
  expanded,
  expandable,
  onToggle,
}: AgentActivityProps) {
  const t = useT();
  // Live-update the elapsed counter every second while running.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  const elapsed = Math.max(0, (endedAt ?? Date.now()) - startedAt);
  const time = formatElapsed(elapsed);
  const label = running
    ? t("panels.activity.working", { time })
    : t("panels.activity.completed", { time });

  return (
    <button
      type="button"
      className={`agent-activity${expanded ? " expanded" : ""}`}
      onClick={onToggle}
      aria-expanded={expandable ? expanded : undefined}
      disabled={!expandable}
    >
      {running
        ? <IconLoader2 size={14} className="spin" />
        : expandable
        ? <IconChevronRight size={14} className="agent-activity-chevron" />
        : <span className="agent-activity-spacer" />}
      <span>{label}</span>
    </button>
  );
}
