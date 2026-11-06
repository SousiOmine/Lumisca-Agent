import {
  IconArrowLeft,
  IconDeviceDesktop,
  IconDeviceDesktopOff,
} from "@tabler/icons-preact";
import { useT } from "../../i18n.ts";
import type { StellaAgentSummary } from "../../types.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";

export interface StellaTitleBarHeaderProps {
  /** The agent whose conversation is open, or null before one is picked (the
   * first screen, and the phone's list). */
  agent: StellaAgentSummary | null;
  /** Whether the machine is up, so the screen toggle can act. The state
   * itself is not drawn here: a reason can be a paragraph, and this strip is
   * one line tall (StellaView has the room for it, and says it there). */
  machineRunning: boolean;
  /** What the header says when it is not about one agent: the list of agents
   * on a phone, or nothing picked yet. */
  label: string;
  /** Return to the list. Present only at phone widths, where the list and the
   * conversation are two screens instead of two columns. */
  onBack?: () => void;
  /** Open the edit dialog for the open agent (name and picture). */
  onEditAgent: () => void;
  /** Show or hide the machine's screen. Omitted while there is nothing to
   * show (see StellaView). */
  onToggleScreen?: () => void;
  /** Whether the screen pane is showing now (the toggle's pressed state).
   * Required rather than optional: an absent `aria-pressed` is not "false"
   * to a screen reader, and the toggle is the only control that reports the
   * pane's state. */
  screenOpen: boolean;
}

/**
 * stella mode's conversation, in the window's title bar.
 *
 * The bar has room the mode was not using: code mode fills it with tabs, and
 * stella — which has no tabs by design — filled it with the app's own name,
 * a label the reader can read in the window's own frame. What belongs there
 * is the answer to "whose conversation is this", which is otherwise a second
 * strip inside the sheet saying the same thing one line lower.
 *
 * Moving it up buys the conversation a row of height and puts the agent's
 * face and name at the top of the window, where a message app puts them. The
 * strip below is gone rather than shortened: two places saying one name is
 * the thing this replaces.
 *
 * The controls are the conversation's, not the window's: back (phone only),
 * the agent's face (which opens the edit dialog), the name, the machine's
 * state while it is worth saying, and the screen toggle at the right edge
 * where the pane it shows appears.
 */
export function StellaTitleBarHeader(
  {
    agent,
    machineRunning,
    label,
    onBack,
    onEditAgent,
    onToggleScreen,
    screenOpen,
  }: StellaTitleBarHeaderProps,
) {
  const t = useT();
  // A toggle that promises a pane that will not appear is worse than no
  // toggle, so the caller's offer is not enough: the machine must be up.
  const showToggle = onToggleScreen !== undefined && machineRunning;

  return (
    <div className="stella-titlebar">
      {
        /* A phone shows one screen at a time (the list, then the
         * conversation), so the way back has to be a control on the
         * conversation rather than a column that is simply not there. */
      }
      {onBack !== undefined && (
        <button
          type="button"
          className="stella-back"
          onClick={onBack}
          title={t("chat.stella.backToList")}
          aria-label={t("chat.stella.backToList")}
        >
          <IconArrowLeft size={18} />
        </button>
      )}
      {agent === null
        ? <span className="stella-titlebar-name">{label}</span>
        : (
          <>
            <button
              type="button"
              className="stella-titlebar-avatar"
              onClick={onEditAgent}
              title={t("chat.stella.agents.edit")}
              aria-label={t("chat.stella.agents.edit")}
            >
              <AgentAvatar
                agentId={agent.id}
                name={agent.name}
                icon={agent.icon}
                size={22}
              />
            </button>
            <h1 className="stella-titlebar-name">{agent.name}</h1>
          </>
        )}
      {showToggle && (
        <button
          type="button"
          className={`stella-screen-toggle${screenOpen ? " on" : ""}`}
          onClick={onToggleScreen}
          aria-pressed={screenOpen}
          title={t(
            screenOpen
              ? "chat.stella.machine.hideScreen"
              : "chat.stella.machine.showScreen",
          )}
          aria-label={t(
            screenOpen
              ? "chat.stella.machine.hideScreen"
              : "chat.stella.machine.showScreen",
          )}
        >
          {screenOpen
            ? <IconDeviceDesktop size={15} />
            : <IconDeviceDesktopOff size={15} />}
        </button>
      )}
    </div>
  );
}
