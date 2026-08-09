import { useEffect, useState } from "react";
import { IconChevronRight, IconLoader2 } from "@tabler/icons-react";

/** Format elapsed milliseconds as "Xm Ys" or "Ys". */
export function formatElapsed(ms: number): string {
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
  // Live-update the elapsed counter every second while running.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  const elapsed = Math.max(0, (endedAt ?? Date.now()) - startedAt);
  const label = running
    ? `${formatElapsed(elapsed)}間作業しています`
    : `${formatElapsed(elapsed)}間作業しました`;

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
