import { useRoutines } from "../../hooks/useRoutines.ts";
import { RoutinePanel } from "./RoutinePanel.tsx";

export interface AgentRoutinesProps {
  /** The agent whose routines this list is about. */
  agentId: string;
  /** The agent is switched off: the list stays readable, but a run is
   * refused by the same rule the server applies. */
  agentDisabled: boolean;
  /** Lay the rows out for the information panel's column. The panel is
   * narrower than the dialog at the same window width, so the viewport's
   * media query cannot decide this. */
  compact?: boolean;
}

/**
 * One agent's routines, with the state and the actions they need.
 *
 * Both ways in draw this body: the dialog an agent's row opens, and the
 * settings section of the information panel. The hook used to live in the
 * dialog, which made a second caller duplicate the polling, the error line
 * and the delete confirmation. Keeping it here means the two paths cannot
 * disagree about any of them, and a caller only decides where the body sits
 * and whether it is the compact layout.
 */
export function AgentRoutines({
  agentId,
  agentDisabled,
  compact = false,
}: AgentRoutinesProps) {
  const routines = useRoutines(agentId);
  return (
    <RoutinePanel
      routines={routines.routines}
      agentDisabled={agentDisabled}
      loading={routines.loading}
      error={routines.error}
      onRefresh={routines.refresh}
      onSetEnabled={routines.setEnabled}
      onRun={routines.run}
      onStop={routines.stop}
      onDelete={routines.remove}
      compact={compact}
    />
  );
}
