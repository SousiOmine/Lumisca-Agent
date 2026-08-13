import { useState } from "react";
import {
  IconChevronDown,
  IconChevronUp,
  IconTerminal,
} from "@tabler/icons-react";
import type { BackgroundView } from "../types.ts";

/** Marker glyph per state, mirroring the async_bash tool's text rendering. */
const STATE_MARKS: Record<BackgroundView["state"], string> = {
  running: "▶",
  finished: "✓",
  killed: "■",
};

/** "N running" while any command runs, otherwise the total count. */
function summary(commands: BackgroundView[]): string {
  const running = commands.filter((c) => c.state === "running").length;
  return running > 0 ? `${running} running` : String(commands.length);
}

/** The session's background commands (the async_bash tool), stacked under
 * the task panel in the same fixed top-right corner. Renders nothing while
 * no command has been started; the header collapses the body to a compact
 * card. While a command runs, its output tail is shown (the completion
 * lands in the chat as a notification). */
export function BackgroundPanel({ commands }: { commands: BackgroundView[] }) {
  const [collapsed, setCollapsed] = useState(false);
  if (commands.length === 0) return null;
  return (
    <div className={`background-panel${collapsed ? " collapsed" : ""}`}>
      <button
        type="button"
        className="background-panel-header"
        title={collapsed ? "展開" : "折りたたみ"}
        onClick={() => setCollapsed((c) => !c)}
      >
        <IconTerminal size={14} />
        <span className="background-panel-title">Background</span>
        <span className="background-panel-summary">{summary(commands)}</span>
        {collapsed
          ? <IconChevronDown size={14} />
          : <IconChevronUp size={14} />}
      </button>
      {!collapsed && (
        <div className="background-panel-body">
          {commands.map((command) => (
            <div
              key={command.commandId}
              className={`background-item ${command.state}`}
            >
              <div className="background-head">
                <span className="background-mark">
                  {STATE_MARKS[command.state]}
                </span>
                <span className="background-name" title={command.command}>
                  {command.command}
                </span>
                <span className="background-meta">
                  {command.state === "running"
                    ? `pid ${command.pid}`
                    : command.state === "finished"
                    ? `exit ${command.exitCode ?? "?"}`
                    : "killed"}
                </span>
              </div>
              {command.state === "running" && command.liveText.length > 0 && (
                <pre className="background-live">
                  {command.liveText.slice(-400)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
