/**
 * The prompts the compactor sends: the checkpoint preamble, the tag framing
 * the summary, and the two summarization instructions (a first pass and the
 * merge a later pass uses).
 *
 * Kept out of context-compaction.ts so that module reads as mechanics (when
 * to compact, what to keep) while the wording, which is tuned by reading it,
 * has a file of its own.
 */

/** The checkpoint preamble: tells the model what the block is and that the
 * work continues after it (pi's compaction summary prefix). */
export const CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span " +
  "of the conversation to free up context. Treat the captured context as " +
  "established background and build on it without restating it. Continue " +
  "the task directly from the messages that follow, without acknowledging " +
  "this checkpoint.";

/** Tags framing the summary inside the checkpoint body. */
export const CHECKPOINT_SUMMARY_TAG = "compacted-summary";

/** System prompt of the summarization call (pi's
 * SUMMARIZATION_SYSTEM_PROMPT): the auxiliary request must not continue the
 * conversation, and it carries no tools. */
export const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant. Your task is to read a " +
  "conversation between a user and an AI assistant, then produce a " +
  "structured summary following the exact format specified.\n\n" +
  "Do NOT continue the conversation. Do NOT respond to any questions in " +
  "the conversation. ONLY output the structured summary.";

/** Instruction appended after the serialized conversation on a first
 * compaction (pi's SUMMARIZATION_PROMPT). */
export const SUMMARIZATION_PROMPT =
  `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Instruction used when a previous checkpoint exists: the previous summary
 * is merged instead of being replaced (pi's UPDATE_SUMMARIZATION_PROMPT). */
export const UPDATE_SUMMARIZATION_PROMPT =
  `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
