import { planMode } from "./plan.ts";
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
 * in the UI sends `buildPrompt(optionId)` (or `buildPromptForText(text)`
 * for text-taking modes) as the user message, so the agent adopts the
 * mode's role and rules for that run without any server support.
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
  /** Badge label shown under the user message, e.g. "レビューモード". */
  modeLabel: string;
  /** Second-level options offered after selecting the mode. */
  options: AgentModeOption[];
  /** The user message sent when the mode (or one of its options) is
   * selected. `optionId` is empty for modes without options. */
  buildPrompt(optionId: string): string;
  /** When set, the mode takes the user's own text as its subject instead
   * of fixed options: the composer keeps the text typed after the command
   * token (e.g. `/plan 履歴機能を追加して`), and this method builds the full
   * prompt from it. The UI then requires that text (nothing is sent while
   * it is missing) and never calls `buildPrompt` for the mode. Modes with
   * this method must have no options. */
  buildPromptForText?(text: string): string;
  /** Build a short display text for the user message, e.g.
   * "未コミットの変更をレビューしてください". Shown in the chat UI
   * instead of the full prompt. */
  buildShortText(optionId: string): string;
}

/** Every registered agent mode, in menu order. */
export const AGENT_MODES: AgentMode[] = [reviewMode, planMode];

export function findAgentMode(id: string): AgentMode | undefined {
  return AGENT_MODES.find((mode) => mode.id === id);
}
