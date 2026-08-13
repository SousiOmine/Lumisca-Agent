import { reviewMode } from "./review.ts";

/** One selectable option of a mode (the second menu level, e.g. the review
 * target). Modes without options keep an empty array: the mode executes
 * directly from the first menu level. */
export interface AgentModeOption {
  id: string;
  /** Menu label, e.g. 「ベースブランチとの差分」. */
  label: string;
  /** Menu description shown under the label. */
  description: string;
}

/**
 * An agent operating mode: a per-message behavior overlay. Selecting a mode
 * in the UI sends `buildPrompt(optionId)` as the user message, so the agent
 * adopts the mode's role and rules for that run without any server support.
 *
 * To add a mode: create a file in this directory implementing AgentMode and
 * register it in AGENT_MODES. The UI renders every registered mode
 * generically (see the web package's slashCommands.ts), so no UI changes
 * are needed.
 */
export interface AgentMode {
  id: string;
  /** Menu label, e.g. 「レビュー」. */
  label: string;
  /** Menu description shown under the label. */
  description: string;
  /** Second-level options offered after selecting the mode. */
  options: AgentModeOption[];
  /** The user message sent when the mode (or one of its options) is
   * selected. `optionId` is empty for modes without options. */
  buildPrompt(optionId: string): string;
}

/** Every registered agent mode, in menu order. */
export const AGENT_MODES: AgentMode[] = [reviewMode];

export function findAgentMode(id: string): AgentMode | undefined {
  return AGENT_MODES.find((mode) => mode.id === id);
}
