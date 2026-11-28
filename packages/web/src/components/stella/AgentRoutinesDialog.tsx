import { IconX } from "@tabler/icons-preact";
import { useT } from "../../i18n.ts";
import type { StellaAgentSummary } from "../../types.ts";
import { Modal } from "../Modal.tsx";
import { AgentRoutines } from "./AgentRoutines.tsx";

export interface AgentRoutinesDialogProps {
  agent: StellaAgentSummary;
  onClose: () => void;
}

/**
 * One agent's routines, opened from its row in the list.
 *
 * The settings dialog used to carry this list, but a routine is not a
 * setting of the app: it schedules a request on ONE agent's conversation, and
 * the list it showed depended on which conversation happened to be open. The
 * row is the honest way in — the reader picks the agent they mean, and the
 * list is that agent's whether or not its conversation is on screen.
 *
 * The body is AgentRoutines, the same component the information panel's
 * settings section draws, so the two ways in list the same rows with the same
 * polling and actions. The dialog is only the title and the close.
 */
export function AgentRoutinesDialog({
  agent,
  onClose,
}: AgentRoutinesDialogProps) {
  const t = useT();
  return (
    <Modal
      onClose={onClose}
      label={t("chat.stella.agents.routinesTitle", { name: agent.name })}
    >
      {(close) => (
        <>
          <div className="modal-header">
            <h2>
              {t("chat.stella.agents.routinesTitle", { name: agent.name })}
            </h2>
            <button
              type="button"
              className="icon-btn push"
              onClick={() => close()}
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <IconX size={16} />
            </button>
          </div>
          <AgentRoutines
            agentId={agent.id}
            agentDisabled={agent.disabledAt !== null}
          />
        </>
      )}
    </Modal>
  );
}
