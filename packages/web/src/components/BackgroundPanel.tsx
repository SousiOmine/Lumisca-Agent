import { useState } from "react";
import {
  IconChevronDown,
  IconChevronUp,
  IconTerminal,
} from "@tabler/icons-react";
import type { BackgroundView } from "../types.ts";

/** The session's background commands (the async_bash tool), stacked under
 * the task panel in the same fixed top-right corner. Shows only the
 * commands that are still running — a finished or killed command disappears
 * from the panel the moment it settles (its completion lands in the chat
 * as a notification instead). Renders nothing while nothing runs; the
 * header collapses the body to a compact card. */
export function BackgroundPanel({ commands }: { commands: BackgroundView[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const running = commands.filter((c) => c.state === "running");
  if (running.length === 0) return null;
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
        <span className="background-panel-summary">
          {running.length} running
        </span>
        {collapsed
          ? <IconChevronDown size={14} />
          : <IconChevronUp size={14} />}
      </button>
      {!collapsed && (
        <div className="background-panel-body">
          {running.map((command) => (
            <div key={command.commandId} className="background-item">
              <div className="background-head">
                <span className="background-mark">▶</span>
                <span className="background-name" title={command.command}>
                  {command.command}
                </span>
                <span className="background-meta">pid {command.pid}</span>
              </div>
              {command.liveText.length > 0 && (
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
