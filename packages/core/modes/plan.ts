import type { AgentMode } from "./mod.ts";

/**
 * Plan mode: the agent drafts an implementation plan for the user's
 * request. It is a text-taking mode: the request is the composer text
 * typed after the `/plan` token (e.g. `/plan add a browsing history
 * feature`), supplied via `buildPromptForText` — the mode has no fixed
 * options.
 *
 * The internal rules enforce the plan-only contract: no file edits until
 * the user explicitly permits them (asked at the end of the planning
 * phase), and questions the agent cannot decide itself go to the ask tool
 * instead of being guessed.
 *
 * English, like every prompt the app sends: the language of the ANSWER is
 * fixed by the session's system prompt (tools/language.ts), so the
 * instructions themselves stay in one reviewable language.
 */

/** The plan-mode internal rules, embedded in every plan prompt. */
const PLAN_RULES = `# Internal rules
- Do not edit or write files until the user explicitly permits it: do not use the write / edit tools, and do not modify files through bash either (redirection, mv / rm / mkdir, git commit / push, ...). Read-only commands (git status / git diff, deno test, and anything else without side effects) may be used for investigation.
- Questions you cannot decide yourself (interpreting the request, the plan's assumptions, the choice of implementation approach — anything that decides whether the plan succeeds) must be asked with the ask tool. Investigate what you can check yourself instead of asking.

# How to proceed
1. Understand the request precisely. If anything is ambiguous, ask the user with the ask tool.
2. Investigate the existing code and structure with the read / grep / glob / list_dir tools and read-only bash commands, and settle the implementation approach.
3. Draft the implementation plan. The plan must include:
   - the goal and the implementation approach
   - the files / modules to change and what changes in each
   - the implementation steps (in phases)
   - how to verify (tests, builds, manual checks)
   - risks and caveats

# Starting implementation
After the plan is drafted, explain it to the user and confirm with the ask tool whether to run it (offer choices such as "proceed with the implementation" and "stop after the plan").
- Start implementing along the plan only once the user explicitly permits it.
- If permission is not given, stop after presenting the plan.
- If you do implement, follow the plan faithfully and report the changes and the verification results when done.`;

/** Build the plan-mode prompt for a request. An empty request yields a
 * defensive fallback that asks the user for it instead of planning
 * blindly (the UI never sends this — it requires the request text). */
export function buildPlanPrompt(request: string): string {
  const trimmed = request.trim();
  const subject = trimmed.length > 0
    ? trimmed
    : "(No request was given. First ask the user for the request with the ask tool.)";
  return `You are an implementation planner. Draft an implementation plan for the user's request. Do not edit the code until the user explicitly permits it.

# Request
${subject}

${PLAN_RULES}`;
}

export const planMode: AgentMode = {
  id: "plan",
  label: "chat.mode.plan.label",
  modeLabel: "chat.mode.plan.modeLabel",
  description: "chat.mode.plan.description",
  options: [],
  // Text-taking mode: the request arrives via buildPromptForText; a plain
  // buildPrompt call has no request, so it falls back to asking the user.
  buildPrompt(): string {
    return buildPlanPrompt("");
  },
  buildPromptForText(text: string): string {
    return buildPlanPrompt(text);
  },
};
