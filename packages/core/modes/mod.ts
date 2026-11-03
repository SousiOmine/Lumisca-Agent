import type { AgentMode } from "./types.ts";

export type { AgentMode, AgentModeOption } from "./types.ts";
import { goalMode } from "./goal.ts";
import { planMode } from "./plan.ts";
import { reviewMode } from "./review.ts";

/** Every registered agent mode, in menu order. */
export const AGENT_MODES: AgentMode[] = [reviewMode, planMode, goalMode];

export function findAgentMode(id: string): AgentMode | undefined {
  return AGENT_MODES.find((mode) => mode.id === id);
}
