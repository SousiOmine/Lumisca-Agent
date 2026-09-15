import type { AgentMode } from "./mod.ts";

/** Default upper bound for the autonomous goal loop (see goal/loop.ts).
 * Kept here so the prompt text and the runtime agree on the same number;
 * a future setting may override it per goal. */
export const DEFAULT_MAX_GOAL_ITERATIONS = 10;

/** The goal-mode internal rules, embedded in every goal prompt (English,
 * like every prompt the app sends). The server-side loop (fast model
 * judge) decides continuation; the agent itself just works toward the
 * goal and reports completion. */
const GOAL_RULES = `# How to proceed
1. Do the work the goal needs: investigate, edit, test, fix.
2. Questions you cannot decide yourself (interpreting the request, the plan's assumptions, the choice of implementation approach — anything that decides whether the work succeeds) must be asked with the ask tool. Investigate what you can check yourself instead of asking.
3. If the user asks you to stop (abort) or rewind while you work, obey immediately.

# Completion
- Once the goal is reached, report completion together with its evidence (test results, the changes you made) and finish.`;

/** Build the goal-mode prompt for a goal. An empty goal yields a defensive
 * fallback that asks the user for it instead of running blindly (the UI
 * never sends this — it requires the goal text). */
export function buildGoalPrompt(goal: string): string {
  const trimmed = goal.trim();
  const subject = trimmed.length > 0
    ? trimmed
    : "(No goal was given. First ask the user for the goal with the ask tool.)";
  return `You are a goal-achieving agent. Keep working autonomously until the following goal is achieved.

# Goal
${subject}

${GOAL_RULES}`;
}

export const goalMode: AgentMode = {
  id: "goal",
  label: "chat.mode.goal.label",
  modeLabel: "chat.mode.goal.modeLabel",
  description: "chat.mode.goal.description",
  options: [],
  // Text-taking mode: the goal arrives via buildPromptForText; a plain
  // buildPrompt call has no goal, so it falls back to asking the user.
  buildPrompt(): string {
    return buildGoalPrompt("");
  },
  buildPromptForText(text: string): string {
    return buildGoalPrompt(text);
  },
};
