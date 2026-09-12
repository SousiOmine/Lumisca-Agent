import type { ContextMessage } from "../ai/types.ts";

/**
 * Dynamic context providers.
 *
 * Some context is per-session and changes while the session lives: the skill
 * catalog (skills appear and disappear on disk) and the workspace
 * instruction files (AGENTS.md is edited). Baking them into the system
 * prompt would freeze them at session creation, so instead every provider
 * publishes them as durable transcript messages — a `context` message — and
 * republishes only when the value changed. This is the DeepSeek Harness's
 * `PromptContext`: the same reason its AssembledContext is materialized as a
 * user-role snapshot instead of prompt text.
 *
 * The system prompt therefore stays a stable, session-independent document
 * (identity, environment, the guidelines for the tools at hand), while the
 * per-session data arrives as history the model can be told to re-read.
 */

/** One message a provider wants published. */
export interface ContextUpdate {
  /** Head line: the UI row label. The body carries the model-facing frame,
   * so the title stays a plain label. */
  title: string;
  /** Model-facing text. */
  body: string;
  /** Snapshot state carried by the published message and handed back to
   * `rebase()`. Stores hashes/versions rather than the payload itself, so a
   * long transcript does not pay for the same content twice. */
  state?: unknown;
}

/** Publishes one kind of dynamic context as durable transcript messages. */
export interface ContextProvider {
  /** Stable provider name; context messages carry it, and the session agent
   * rebases the provider from the last message of that name. */
  readonly name: string;
  /** The updates to publish now; empty when nothing changed. Called before
   * every run, so the check must stay cheap (a snapshot read, not a
   * rebuild of a heavy value). */
  next(): ContextUpdate[];
  /** Re-anchor to a previous publication: the state of the last context
   * message of this provider still present in the transcript, or undefined
   * when the transcript holds none (a fresh session, or a rewind that
   * removed it). After a rebase the provider publishes again unless the
   * value is unchanged. */
  rebase(state: unknown): void;
}

/** The context message for one update (role + provenance + timestamp). */
export function contextMessage(
  provider: string,
  update: ContextUpdate,
  timestamp: number,
): ContextMessage {
  return {
    role: "context",
    provider,
    title: update.title,
    body: update.body,
    ...(update.state !== undefined ? { state: update.state } : {}),
    timestamp,
  };
}
