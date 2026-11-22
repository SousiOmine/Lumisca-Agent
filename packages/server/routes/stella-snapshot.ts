/**
 * The snapshot a conversation endpoint answers with: a window of the entries
 * as the client draws them, plus the live state the event stream cannot
 * restore on its own (the run, the wait it is blocked on, the lent folders).
 *
 * Two shapes, because a conversation can be read without being open: an open
 * one is read from the live transcript, and a disabled agent's from the store
 * alone, where every live field is empty by definition (no run, no hand-over,
 * nothing waiting for an answer). Both are assembled here so the endpoints
 * that open, re-read and serve a disabled conversation cannot drift apart.
 */
import type {
  SessionInfo,
  StellaAgent,
  StellaConversationSnapshot,
  WindowQuery,
} from "@lumisca/core";
import type { StellaApi } from "../contracts/stella.ts";
import { AppError } from "./util.ts";

/** The methods the two shapes read: the same conversation at two moments of
 * its life, so the same view of it. */
export type StellaSnapshotApi = Pick<
  StellaApi,
  | "findStellaSession"
  | "getAgent"
  | "getPendingEnvRequest"
  | "getPendingHandover"
  | "getPendingQuestions"
  | "getPendingShareRequest"
  | "getSessionLastError"
  | "getSessionRevision"
  | "getShares"
  | "getStellaAgent"
  | "getThinkingState"
  | "readStellaConversation"
  | "readStellaConversationFromStore"
>;

/** The snapshot of a conversation nobody may open. Read from the store;
 * every live field is empty by definition, because a disabled agent has no
 * run, no hand-over and nothing waiting for an answer.
 *
 * A conversation that was never opened has no session row, so it is drawn
 * as an empty history with no assets to address. The row is created when
 * the agent is switched on and opened, not by a read: creating it here
 * would need a model for a conversation nobody can send to.
 */
export function readOnlySnapshot(
  api: StellaSnapshotApi,
  agent: StellaAgent,
  query: WindowQuery,
): StellaConversationSnapshot {
  const session = api.findStellaSession(agent.id);
  const page =
    session === undefined
      ? { items: [], older: null }
      : api.readStellaConversationFromStore(session.id, query);
  return {
    entries: page.items,
    older: page.older,
    running: false,
    questions: [],
    handover: null,
    envRequest: null,
    shareRequest: null,
    shares: [],
    agentName: agent.name,
    disabled: true,
    sessionId: session?.id ?? null,
    model:
      session === undefined
        ? null
        : { provider: session.modelProvider, modelId: session.modelId },
    ...(session === undefined ? {} : api.getThinkingState(session.id)),
    rev: session === undefined ? 0 : api.getSessionRevision(session.id),
  };
}

/** One conversation snapshot: a window of the entries as the client draws
 * them plus the live state the event stream cannot restore on its own. */
export function snapshotOf(
  api: StellaSnapshotApi,
  session: SessionInfo,
  agentId: string,
  query: WindowQuery,
): StellaConversationSnapshot {
  const page = api.readStellaConversation(session.id, query);
  if (page === undefined) {
    // Unreachable: every caller opened the conversation (open, or a route
    // that requires an existing one), and a conversation is only ever
    // read while it is open. Do not invent an empty transcript for it.
    throw new AppError(`Conversation is not open: ${agentId}`, 409);
  }
  return {
    entries: page.items,
    // The way back through the conversation; null at its beginning.
    older: page.older,
    running: api.getAgent(session.id)?.isStreaming === true,
    questions: api.getPendingQuestions(session.id),
    handover: api.getPendingHandover(session.id),
    envRequest: api.getPendingEnvRequest(session.id),
    shareRequest: api.getPendingShareRequest(session.id),
    shares: api.getShares(session.id),
    ...(lastErrorOf(api, session.id) !== undefined
      ? { error: lastErrorOf(api, session.id) }
      : {}),
    agentName: api.getStellaAgent(agentId)?.name ?? session.name,
    disabled: false,
    sessionId: session.id,
    // The model the conversation runs on. The client shows it in the
    // composer's model line, and switches from there; the conversation's
    // session row is the source of truth, so it travels with the snapshot
    // rather than being guessed from the app default.
    model: { provider: session.modelProvider, modelId: session.modelId },
    // The model's thinking strength, beside the model for the same reason:
    // the composer shows both from one line, and a stella request that
    // takes many steps is where the choice matters most.
    ...api.getThinkingState(session.id),
    rev: api.getSessionRevision(session.id),
  };
}

function lastErrorOf(
  api: StellaSnapshotApi,
  sessionId: string,
): string | undefined {
  return api.getSessionLastError(sessionId);
}
