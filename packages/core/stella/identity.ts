/**
 * The stella agent's identity: the text it writes about ITSELF, and the tool
 * that writes it.
 *
 * Two things are easy to conflate, and the difference matters:
 *
 * - `role` (stella/agents.ts) is what the USER wrote when the agent was
 *   created. It goes into the system prompt, which is snapshotted once per
 *   session, and nothing rewrites it.
 * - the identity is the AGENT's own note: the role it has taken, what it is
 *   responsible for, the knowledge the work needs. It is stored on the agent
 *   row and written into the system prompt when that prompt is generated.
 *
 * The prompt is the request's first tokens, so a session must not rewrite it
 * while it lives: a rewrite throws away the provider's cached prefix on every
 * later request. The text is therefore fixed at generation, and the one place
 * it is refreshed is a compaction — the history behind the prompt has just
 * been replaced, so the next request has no cache to keep anyway. A write by
 * the tool lands in the stored row at once, but the model reads it from the
 * prompt only after the conversation is compacted or reopened. The tool's
 * result says so, and its `read` action shows the stored text now.
 */
import { TOOL_IDENTITY } from "../shared/mod.ts";
import {
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "../tools/schema.ts";
import { MAX_AGENT_IDENTITY_CHARS } from "./agents.ts";

/** What the tool needs of the agent row. A seam, so the tool is testable
 * without a database (the repo backs it in core.ts). */
export interface IdentityTarget {
  /** The stored identity; an empty string when the agent wrote none. */
  read(): string;
  /** Replace it (trimmed and length-checked by the repo). */
  write(content: string): void;
}

const identitySchema = object({
  action: string(
    'The operation: "read" shows the identity you wrote, "write" replaces ' +
      'the whole text, "edit" changes one passage of it.',
  ),
  content: optional(
    string(
      `The new identity for action "write" (at most ` +
        `${MAX_AGENT_IDENTITY_CHARS} characters). An empty string clears it.`,
    ),
  ),
  old_string: optional(
    string(
      'For action "edit": the exact text to replace. It must appear exactly ' +
        "once in the identity — include surrounding lines to make it unique.",
    ),
  ),
  new_string: optional(
    string(
      'For action "edit": the replacement text. An empty string deletes the ' +
        "matched passage.",
    ),
  ),
});

/**
 * `identity`: read and rewrite the agent's own description of itself.
 *
 * Discoverable through `tool_search` rather than preloaded: a conversation
 * that never writes about itself should not pay for the definition on every
 * turn. The description states WHEN a change takes effect (the next
 * compaction or open), because a model that cannot see its own text change
 * would otherwise assume the write failed.
 *
 * `edit` exists alongside `write` because identity is updated incrementally:
 * the setup turn learns one thing per message, and a later run may learn a
 * preference in passing. Replacing the whole text for that costs the tokens
 * of the whole note and gives the model a chance to drop a line it meant to
 * keep. The match is exact and must be unique — the same contract as the
 * file `edit` — so an ambiguous passage fails instead of silently changing
 * the wrong one. There is no `append`: the note is meant to stay short and
 * organized, and appending is how it becomes neither.
 */
export function createIdentityTool(
  target: IdentityTarget,
): Tool<typeof identitySchema> {
  return {
    name: TOOL_IDENTITY,
    label: "Identity",
    description:
      "Your identity: the text you wrote about yourself — the role you take, " +
      "what you are responsible for, and the knowledge your work needs. You " +
      "own it, and it is separate from the role the user gave you at " +
      'creation. Action "read" returns the stored text; action "write" ' +
      "replaces the whole text with `content` (an empty string clears it); " +
      'action "edit" replaces one occurrence of `old_string` with ' +
      "`new_string` (it must appear exactly once — include more context " +
      "when it does not). A change does not change the system prompt of " +
      "the current conversation: the prompt is rebuilt when the " +
      "conversation is compacted or reopened, so check the stored text " +
      'with "read" rather than assuming the prompt above changed. Keep it ' +
      "under " +
      `${MAX_AGENT_IDENTITY_CHARS} characters, write what a future you needs, ` +
      "and never put secrets or tokens in it.",
    parameters: identitySchema,
    execute: (_toolCallId, params): Promise<ToolResult> => {
      const action = params.action.trim();
      // What a successful change answers (write and edit share it): the
      // model must not assume the change is visible in the run that made it.
      const changed = (text: string): ToolResult => ({
        content: [
          {
            type: "text",
            text:
              text.length === 0
                ? "Your identity was cleared. The system prompt keeps the " +
                  "previous text until the conversation is compacted or " +
                  "reopened."
                : "Your identity was updated. The system prompt keeps the " +
                  "previous text until the conversation is compacted or " +
                  "reopened.",
          },
        ],
        details: { action, length: text.length },
      });
      switch (action) {
        case "read": {
          const text = target.read();
          return Promise.resolve({
            content: [
              {
                type: "text",
                text:
                  text.length === 0
                    ? "You have not written an identity yet. Write one with " +
                      'action "write" when you know the role you take.'
                    : `Your identity:\n<identity>\n${text}\n</identity>`,
              },
            ],
            details: { action, length: text.length },
          });
        }
        case "write": {
          if (params.content === undefined) {
            throw new Error(
              'action "write" needs content. Pass an empty string to clear ' +
                "your identity.",
            );
          }
          target.write(params.content);
          return Promise.resolve(changed(target.read()));
        }
        case "edit": {
          if (
            params.old_string === undefined ||
            params.new_string === undefined
          ) {
            throw new Error('action "edit" needs old_string and new_string.');
          }
          if (params.old_string.length === 0) {
            throw new Error(
              'old_string must not be empty. Use action "write" to replace ' +
                "the whole text.",
            );
          }
          const current = target.read();
          if (current.length === 0) {
            throw new Error(
              "You have not written an identity yet, so there is nothing to " +
                'edit. Use action "write" to write it.',
            );
          }
          // The same contract as the file `edit`: exact, unique, and a
          // failure rather than a guess. Replacing the first of several
          // matches can silently change the wrong passage, and the model then
          // writes the rest of its setup on top of it.
          const occurrences = current.split(params.old_string).length - 1;
          if (occurrences === 0) {
            throw new Error(
              "old_string not found in your identity. Read it first (action " +
                '"read") and copy the passage exactly.',
            );
          }
          if (occurrences > 1) {
            throw new Error(
              `old_string appears ${occurrences} times in your identity; ` +
                "include more surrounding context to make it unique.",
            );
          }
          target.write(current.replace(params.old_string, params.new_string));
          return Promise.resolve(changed(target.read()));
        }
        default:
          throw new Error(
            `Unknown action "${params.action}". Use "read", "write" or "edit".`,
          );
      }
    },
  };
}
