import { IconChevronRight } from "@tabler/icons-preact";
import { useState } from "preact/hooks";
import { useT } from "../../i18n.ts";
import { AgentMcpServers } from "./AgentMcpServers.tsx";
import { AgentRoutines } from "./AgentRoutines.tsx";

export interface AgentSettingsPanelProps {
  /** The open conversation's agent, or null before one is picked. */
  agentId: string | null;
  /** The agent is switched off, so its routines cannot run. */
  agentDisabled: boolean;
  /** Start expanded. The panel leaves this false; the tests render both
   * states without a DOM. */
  defaultOpen?: boolean;
}

/**
 * The agent's settings inside the information panel: its schedules and its
 * MCP servers.
 *
 * Both items belong to the open agent, so they share one heading rather than
 * each growing a section of its own. Each body is mounted when its item
 * opens: the routines are read from the server and the MCP panel reads two
 * config lists, and a closed item must fetch neither every time the panel is
 * shown. A re-open re-reads, which is what both lists want anyway.
 */
export function AgentSettingsPanel({
  agentId,
  agentDisabled,
  defaultOpen = false,
}: AgentSettingsPanelProps) {
  const t = useT();
  const [routinesOpen, setRoutinesOpen] = useState(defaultOpen);
  const [mcpOpen, setMcpOpen] = useState(false);
  if (agentId === null) return null;
  const routinesLabel = t("chat.stella.agents.routines");
  const mcpLabel = t("chat.stella.agentMcp.title");
  return (
    <section
      className="stella-agent-settings"
      aria-label={t("chat.stella.agentSettings.title")}
    >
      <h3 className="stella-pane-section">
        {t("chat.stella.agentSettings.title")}
      </h3>
      <button
        type="button"
        className="stella-settings-toggle"
        aria-expanded={routinesOpen}
        aria-controls={routinesOpen ? "stella-agent-routines" : undefined}
        onClick={() => setRoutinesOpen((previous) => !previous)}
      >
        <span className="stella-settings-chevron" aria-hidden="true">
          <IconChevronRight size={14} />
        </span>
        <span>{routinesLabel}</span>
      </button>
      {routinesOpen && (
        <div
          className="stella-settings-body"
          id="stella-agent-routines"
          role="region"
          aria-label={routinesLabel}
        >
          <AgentRoutines
            agentId={agentId}
            agentDisabled={agentDisabled}
            compact
          />
        </div>
      )}
      <button
        type="button"
        className="stella-settings-toggle"
        aria-expanded={mcpOpen}
        aria-controls={mcpOpen ? "stella-agent-mcp" : undefined}
        onClick={() => setMcpOpen((previous) => !previous)}
      >
        <span className="stella-settings-chevron" aria-hidden="true">
          <IconChevronRight size={14} />
        </span>
        <span>{mcpLabel}</span>
      </button>
      {mcpOpen && (
        <div
          className="stella-settings-body"
          id="stella-agent-mcp"
          role="region"
          aria-label={mcpLabel}
        >
          <AgentMcpServers agentId={agentId} />
        </div>
      )}
    </section>
  );
}
