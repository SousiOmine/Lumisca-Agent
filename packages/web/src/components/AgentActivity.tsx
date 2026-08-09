import { useEffect, useState } from "react";
import { IconBrain, IconClock, IconLoader2 } from "@tabler/icons-react";
import { isViewRunning, type SessionView } from "../types.ts";

/** Format elapsed milliseconds as "Xm Ys" or "Ys". */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

interface AgentActivityProps {
  view: SessionView;
}

/**
 * Compact status header shown at the top of the chat while the agent is
 * running. Displays elapsed time and a thinking indicator.
 *
 * Matches the Claude Code style:
 *   ⏱ Worked for 1m 18s
 *   🧠 Thought for a few seconds
 */
export function AgentActivity({ view }: AgentActivityProps) {
  const running = isViewRunning(view);
  const elapsed = (view.agentEndedAt ?? Date.now()) - (view.agentStartedAt ?? 0);
  const showElapsed = elapsed > 0;
  const showThinking = running && view.thinkingStartAt !== undefined;

  // Live-update the elapsed counter every second while running.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (!showElapsed && !showThinking) return null;

  return (
    <div className="agent-activity">
      {showElapsed && (
        <div className="agent-activity-row">
          {running
            ? <IconLoader2 size={14} className="spin" />
            : <IconClock size={14} />}
          <span>
            {running ? "Working" : "Worked"} for {formatElapsed(elapsed)}
          </span>
        </div>
      )}
      {showThinking && (
        <div className="agent-activity-row">
          <IconBrain size={14} />
          <span>Thinking...</span>
        </div>
      )}
    </div>
  );
}
