import { IconTerminal } from "@tabler/icons-preact";
import type { BackgroundView } from "../types.ts";
import { useT } from "../i18n.ts";
import { CollapsiblePanel } from "./Panel.tsx";

/** The session's running background commands (the async_bash tool). A
 * settled command disappears from the panel: its completion lands in the
 * chat as a notification. */
export function BackgroundPanel({ commands }: { commands: BackgroundView[] }) {
  const t = useT();
  const running = commands.filter((c) => c.state === "running");
  if (running.length === 0) return null;
  return (
    <CollapsiblePanel
      kind="background-panel"
      icon={<IconTerminal size={14} />}
      title={t("panels.background.title")}
      summary={`${running.length} running`}
    >
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
    </CollapsiblePanel>
  );
}
