import { IconChevronRight } from "@tabler/icons-preact";
import { useState } from "preact/hooks";
import { useT } from "../../i18n.ts";
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
 * The agent's settings inside the information panel.
 *
 * A heading and one item so far. The heading is a group rather than a single
 * disclosure because the settings that follow it are per-agent items: MCP
 * servers are the next one, and they belong to the same agent as its
 * routines. Keeping the group here means the panel does not grow a second
 * shape when that item arrives.
 *
 * The routine body is mounted when the item opens. The settings pages keep
 * their disclosures mounted so they can animate closed; this one is read from
 * the server, and a closed section must not fetch an agent's routines every
 * time the panel is shown. The body therefore appears and disappears at once,
 * and a re-open re-reads the list, which is what a schedule wants anyway.
 */
export function AgentSettingsPanel({
  agentId,
  agentDisabled,
  defaultOpen = false,
}: AgentSettingsPanelProps) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  if (agentId === null) return null;
  const label = t("chat.stella.agents.routines");
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
        aria-expanded={open}
        aria-controls={open ? "stella-agent-routines" : undefined}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className="stella-settings-chevron" aria-hidden="true">
          <IconChevronRight size={14} />
        </span>
        <span>{label}</span>
      </button>
      {open && (
        <div
          className="stella-settings-body"
          id="stella-agent-routines"
          role="region"
          aria-label={label}
        >
          <AgentRoutines
            agentId={agentId}
            agentDisabled={agentDisabled}
            compact
          />
        </div>
      )}
    </section>
  );
}
