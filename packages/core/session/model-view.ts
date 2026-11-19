/**
 * The messages a model is shown, with the whole-transcript position the
 * first of them sits at.
 *
 * Four call sites asked the store the same pair of questions (opening a
 * conversation, reopening one, rebuilding a store, and the facade's run
 * setup). The base index is the part that is easy to get wrong: a window
 * read from the store starts after everything the transcript holds, so the
 * difference between the agent's row count and the window's length is the
 * only correct answer.
 */
import type { AgentMessage } from "../ai/message.ts";

/** The store operations this view needs. `MessageRepo` satisfies it. */
export interface ModelViewRepo {
  listModelView(agentId: string): { message: AgentMessage }[];
  count(agentId: string, rows: "all"): number;
}

export interface ModelView {
  messages: AgentMessage[];
  /** The whole-transcript position `messages[0]` sits at. */
  baseIndex: number;
}

export function modelViewOf(repo: ModelViewRepo, agentId: string): ModelView {
  const rows = repo.listModelView(agentId);
  return {
    messages: rows.map((row) => row.message),
    baseIndex: repo.count(agentId, "all") - rows.length,
  };
}
