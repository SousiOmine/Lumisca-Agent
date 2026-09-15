import type { AgentMode } from "./mod.ts";

/** What the review covers: the branch's diff against its base, or the
 * uncommitted worktree changes. */
export type ReviewTarget = "base-diff" | "uncommitted";

/** Shared review rules (English, like every prompt the app sends). The
 * language of the report itself follows the session's output-language rule
 * (tools/language.ts), not the language of these instructions. */
const REVIEW_RULES = `# Review rules
- Report only problems that have a meaningful effect on correctness, performance, security or maintainability.
- A finding must be concrete and fixable. No vague impressions or matters of taste.
- Focus on problems the author would actually want to fix once they know about them.
- Do not make implicit assumptions about the author's intent. If a change's intent cannot be read from the code, report that as a finding.
- "This probably breaks something else" is not enough. Read the code, identify the places actually affected (callers, usages) and show the evidence.
- Do not treat clearly intentional changes (refactoring, renames, explicit trade-offs) as bugs; say that they look intentional instead.
- Do not dig up pre-existing problems outside the reviewed diff.

# Report format
For each finding, include:
- Location: file path and line number (or the changed hunk)
- Problem: what is wrong
- Impact: why it matters, what it affects
- Suggested direction: how it should be fixed`;

/** Git steps for the uncommitted-changes target. */
const UNCOMMITTED_STEPS = `For uncommitted changes:
- List the changed files with \`git status\`.
- Get the diff of both staged and unstaged changes with \`git diff HEAD\`.
- Untracked new files also appear in \`git status\`: read the ones that belong to this change and include them in the review.`;

/** Git steps for the base-branch-diff target. */
const BASE_DIFF_STEPS = `For the diff against the base branch:
- Check the current branch with \`git branch --show-current\`.
- Identify the base branch: use \`main\` or \`master\` when the repository has one; otherwise read the remote's default branch (HEAD) from \`git remote show origin\`.
- Get the branch's changes with \`git diff <base branch>...HEAD\`.
- When the current branch IS the base branch, the diff is empty.`;

/** How the reviewed target is named in the prompt. English, like the rest
 * of the prompt; the menu calls the same target something else (see the
 * catalogue's chat.mode.review.option.*). */
const REVIEW_TARGET_PROMPT_LABELS: Record<ReviewTarget, string> = {
  "base-diff": "The diff against the base branch",
  uncommitted: "The uncommitted changes",
};

/** Build the review user message for a target. The agent fetches the diff
 * itself with its git/bash tools, so no server support is needed. */
export function buildReviewPrompt(target: ReviewTarget): string {
  const targetLabel = REVIEW_TARGET_PROMPT_LABELS[target];
  const steps = target === "uncommitted" ? UNCOMMITTED_STEPS : BASE_DIFF_STEPS;
  return `You are a code reviewer. Review the code changes another engineer made and report your findings. Do not fix the code: editing and writing files is forbidden, findings only.

# Target
${targetLabel}

# How to proceed
1. Run git commands with the bash tool to get the reviewed changes.
${steps}
- If the diff is empty, or this is not a git repository, report that and stop.
- If the diff is large (bash output gets truncated), split it per file, e.g. \`git diff -- <path>\`.
2. Read the changed files and their surroundings with the read / grep / glob tools to understand exactly what changed and what it affects.

${REVIEW_RULES}`;
}

export const reviewMode: AgentMode = {
  id: "review",
  label: "chat.mode.review.label",
  modeLabel: "chat.mode.review.modeLabel",
  description: "chat.mode.review.description",
  options: [
    {
      id: "base-diff",
      label: "chat.mode.review.option.baseDiff.label",
      description: "chat.mode.review.option.baseDiff.description",
      shortText: "chat.mode.review.option.baseDiff.shortText",
    },
    {
      id: "uncommitted",
      label: "chat.mode.review.option.uncommitted.label",
      description: "chat.mode.review.option.uncommitted.description",
      shortText: "chat.mode.review.option.uncommitted.shortText",
    },
  ],
  buildPrompt(optionId: string): string {
    const target = optionId === "uncommitted" ? "uncommitted" : "base-diff";
    return buildReviewPrompt(target);
  },
};
