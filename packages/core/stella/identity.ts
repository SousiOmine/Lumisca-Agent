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
 *   row and reaches the model as a durable CONTEXT message (see
 *   contextProviders), so a write is visible from the next run without
 *   touching the system prompt.
 *
 * That last part is the whole design. Rewriting the system prompt mid-session
 * changes the request's first tokens, which throws away the provider's cached
 * prefix on every write — the one cost this codebase is careful about
 * everywhere else (see ai/context-providers.ts). Publishing a context
 * message instead appends to the transcript: the cache keeps serving the
 * unchanged head, and the model still reads the new text on its next turn.
 *
 * Terasuma's `identity` tool does the same job with one difference: there the
 * new text only takes effect at the next compaction (the system prompt carries
 * a frozen copy). Lumisca has no frozen copy to update — the identity is
 * never in the system prompt — so a write lands one turn later, always.
 */
import type {
  ContextProvider,
  ContextUpdate,
} from "../ai/context-providers.ts";
import { fnv1a } from "../shared/digest.ts";
import { TOOL_IDENTITY } from "../shared/mod.ts";
import {
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "../tools/schema.ts";
import { MAX_AGENT_IDENTITY_CHARS } from "./agents.ts";

/** Provider name of the identity context message. */
export const IDENTITY_PROVIDER = "identity";

/** What the tool and the context provider need of the agent row. A seam, so
 * both are testable without a database (the repo backs it in core.ts). */
export interface IdentityTarget {
  /** The stored identity; an empty string when the agent wrote none. */
  read(): string;
  /** Replace it (trimmed and length-checked by the repo). */
  write(content: string): void;
}

const identitySchema = object({
  action: string(
    'The operation: "read" shows the identity you wrote, "write" replaces it.',
  ),
  content: optional(string(
    `The new identity for action "write" (at most ` +
      `${MAX_AGENT_IDENTITY_CHARS} characters). An empty string clears it.`,
  )),
});

/**
 * `identity`: read and rewrite the agent's own description of itself.
 *
 * Preloaded rather than discoverable: an agent that does not know it may write
 * about itself never does, and the definition costs one short line on every
 * turn — the same reasoning as the screen tools. The description states WHEN
 * the write takes effect (the next run), because a model that cannot see its
 * own text change would otherwise assume the write failed.
 */
export function createIdentityTool(target: IdentityTarget): Tool<
  typeof identitySchema
> {
  return {
    name: TOOL_IDENTITY,
    label: "Identity",
    description:
      "Your identity: the text you wrote about yourself — the role you take, " +
      "what you are responsible for, and the knowledge your work needs. You " +
      "own it, and it is separate from the role the user gave you at " +
      'creation. Action "read" returns the stored text; action "write" ' +
      "replaces it with `content` (an empty string clears it). A write does " +
      "not change what the model sees in the current run: it is added to " +
      "your context when the next run starts, so check it with " +
      '"read" rather than assuming the text above changed. Keep it under ' +
      `${MAX_AGENT_IDENTITY_CHARS} characters, write what a future you needs, ` +
      "and never put secrets or tokens in it.",
    parameters: identitySchema,
    execute: (_toolCallId, params): Promise<ToolResult> => {
      const action = params.action.trim();
      switch (action) {
        case "read": {
          const text = target.read();
          return Promise.resolve({
            content: [{
              type: "text",
              text: text.length === 0
                ? "You have not written an identity yet. Write one with " +
                  'action "write" when you know the role you take.'
                : `Your identity:\n<identity>\n${text}\n</identity>`,
            }],
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
          const text = target.read();
          return Promise.resolve({
            content: [{
              type: "text",
              text: text.length === 0
                ? "Your identity was cleared. Your context keeps the previous " +
                  "text until your next turn, and then carries none."
                : "Your identity was updated. Your context keeps the previous " +
                  "text until your next turn, and then carries this one.",
            }],
            details: { action, length: text.length },
          });
        }
        default:
          throw new Error(
            `Unknown action "${params.action}". Use "read" or "write".`,
          );
      }
    },
  };
}

/** The state a published identity message carries: the hash of the text it
 * published. The text itself is not stored twice (a long transcript must not
 * pay for the same note repeatedly). */
interface IdentityState {
  hash: string;
}

function hashOf(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const hash = (state as IdentityState).hash;
  return typeof hash === "string" ? hash : undefined;
}

function framed(text: string): string {
  return `<identity>\n${text}\n</identity>`;
}

/**
 * The identity context provider: publishes the agent's own text as a durable
 * transcript message, and republishes only when it changed.
 *
 * Read on every run (`next()` is called before each one), so a write by the
 * agent itself reaches the very next request. The first publication is a
 * complete statement; a later one says it replaces the earlier text, so a
 * model reading the transcript cannot mistake a stale copy for the current
 * one.
 */
export function createIdentityProvider(
  target: IdentityTarget,
): ContextProvider {
  /** Hash of the last publication; undefined until the first one. A cleared
   * identity publishes the empty string's hash, so the notice is not
   * repeated (see next()). */
  let published: string | undefined;
  // Computed once: the hash of "nothing written", which is a state the
  // provider can publish (a clear) but never describes as an earlier text.
  const emptyHash = fnv1a("");

  return {
    name: IDENTITY_PROVIDER,
    next(): ContextUpdate[] {
      const text = target.read();
      const hash = fnv1a(text);
      if (text.length === 0) {
        // Nothing to say to an agent that never wrote one (published is
        // undefined) or to one that has already been told its text was
        // cleared (published is the empty hash). A CLEARED identity is worth
        // one message: the earlier text is stale now.
        if (published === undefined || published === emptyHash) return [];
        published = emptyHash;
        return [{
          title: "Identity (cleared)",
          body: "Your identity was cleared. The text you wrote about " +
            "yourself no longer applies.",
          state: { hash } satisfies IdentityState,
        }];
      }
      if (published === hash) return [];
      const replaces = published !== undefined && published !== emptyHash;
      published = hash;
      const body = `Your identity: the text you wrote about yourself with the
identity tool. It is your standing description of who you are and what you
know, and it is separate from the role the user gave you at creation — that
one stays as they wrote it.${
        replaces ? " This text replaces the earlier one." : ""
      }

${framed(text)}`;
      return [{
        title: "Identity (written by you)",
        body,
        state: { hash } satisfies IdentityState,
      }];
    },
    rebase(state: unknown): void {
      published = hashOf(state);
    },
  };
}
