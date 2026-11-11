import { IconX } from "@tabler/icons-preact";
import { useRoutines } from "../../hooks/useRoutines.ts";
import { useT } from "../../i18n.ts";
import type { StellaAgentSummary } from "../../types.ts";
import { Modal } from "../Modal.tsx";
import { RoutinePanel } from "./RoutinePanel.tsx";

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
 * The hook owns the list, so the dialog is a shell: a title, a close, and the
 * list itself.
 */
export function AgentRoutinesDialog({
  agent,
  onClose,
}: AgentRoutinesDialogProps) {
  const t = useT();
  const routines = useRoutines(agent.id);
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
              <IconX size={15} />
            </button>
          </div>
          <RoutinePanel
            routines={routines.routines}
            loading={routines.loading}
            error={routines.error}
            onRefresh={routines.refresh}
            onSetEnabled={routines.setEnabled}
            onRun={routines.run}
            onStop={routines.stop}
            onDelete={routines.remove}
          />
        </>
      )}
    </Modal>
  );
}
