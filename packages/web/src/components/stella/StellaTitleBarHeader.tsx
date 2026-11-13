import {
  IconArrowLeft,
  IconLayoutSidebarRight,
} from "@tabler/icons-preact";
import { useT } from "../../i18n.ts";
import type { StellaAgentSummary } from "../../types.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";

export interface StellaTitleBarHeaderProps {
  /** The agent whose conversation is open, or null before one is picked (the
   * first screen, and the phone's list). */
  agent: StellaAgentSummary | null;
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
 * With nothing picked there is nothing to say: the app's name stood there
 * while the list was on screen, and a window already framed as Lumisca Agent
 * was naming itself twice. The bar is a drag surface and the controls' row
 * then, not a caption.
 *
 * Moving it up buys the conversation a row of height and puts the agent's
 * face and name at the top of the window, where a message app puts them. The
 * strip below is gone rather than shortened: two places saying one name is
 * the thing this replaces.
 *
 * The controls are the conversation's, not the window's: back (phone only),
 * the agent's face (which opens the edit dialog), the name, the machine's
 * state while it is worth saying, and the information panel's toggle at the
 * right edge, where the panel appears.
 */
export function StellaTitleBarHeader({
  agent,
  onBack,
  onEditAgent,
  onToggleScreen,
  screenOpen,
}: StellaTitleBarHeaderProps) {
  const t = useT();
  // The caller decides: the panel is the conversation's information, and it
  // has something to say with the machine still starting (a lent folder).
  const showToggle = onToggleScreen !== undefined;

  return (
    <div className="stella-titlebar">
      {/* A phone shows one screen at a time (the list, then the
       * conversation), so the way back has to be a control on the
       * conversation rather than a column that is simply not there. */}
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
      {agent !== null && (
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
          <IconLayoutSidebarRight size={17} />
        </button>
      )}
    </div>
  );
}
