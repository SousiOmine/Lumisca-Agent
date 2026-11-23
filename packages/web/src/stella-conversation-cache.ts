import type { StellaConversationState } from "./stella-state.ts";

/** One conversation as the client last read or advanced it. */
export interface CachedConversation {
  conversation: StellaConversationState;
  /** The conversation's session id, for the asset bases built beside the
   * transcript. Kept with the state because the two are replaced together. */
  sessionId: string | null;
}

/** What the transcript draws for the agent the address names: the live
 * conversation when its read has landed, the page's cached copy while that
 * read is in flight, or nothing when this page has never had it. */
export interface ShownConversation {
  conversation: StellaConversationState | null;
  /** Whose state `conversation` is, or null when there is none. A cached
   * conversation still belongs to the agent the address names: the reader
   * chose that agent, and its messages are that agent's. */
  agentId: string | null;
  sessionId: string | null;
  /** Whether the state is the server's read for this agent. A cached copy
   * answers the first frame, but its preview must not rewrite the sidebar
   * row: the list may have heard of a newer message while the reader was
   * away, and the read that follows is the one that decides. */
  settled: boolean;
}

/** How many conversations this page keeps. Selecting an agent is the most
 * frequent move in stella mode, and the reader moves among a handful of
 * agents; a conversation they already read must not start as a blank screen
 * because its state was dropped when they looked away. The bound is on
 * states, not agents: a page that visited dozens of agents keeps the ones
 * used last, and the memory of the rest goes. */
export const CONVERSATION_CACHE_SIZE = 8;

/**
 * The conversations this page has already read, newest use last.
 *
 * The server remains the truth: an entry here is what the client knew when it
 * left a conversation, shown only until the read the selection starts lands.
 * It is written on every state change, so a message that arrived over the
 * socket is in it, and it is replaced, not merged, when that read answers:
 * a message the server no longer has (a rewind made from another window)
 * must disappear with the copy that still holds it.
 *
 * Insertion order is the use order: a conversation is moved to the end each
 * time it changes, and the oldest is dropped when the bound is crossed.
 */
export class ConversationCache {
  readonly #conversations = new Map<string, CachedConversation>();

  get(agentId: string): CachedConversation | undefined {
    return this.#conversations.get(agentId);
  }

  remember(
    agentId: string,
    conversation: StellaConversationState,
    sessionId: string | null,
  ): void {
    // Delete first so the write moves an existing agent to the newest slot.
    this.#conversations.delete(agentId);
    this.#conversations.set(agentId, { conversation, sessionId });
    while (this.#conversations.size > CONVERSATION_CACHE_SIZE) {
      const oldest = this.#conversations.keys().next().value;
      if (oldest === undefined) break;
      this.#conversations.delete(oldest);
    }
  }
}

/**
 * Which conversation the transcript draws.
 *
 * The address is the choice; this decides what can be shown for it right
 * now. The live state wins whenever it belongs to the chosen agent. Until it
 * does, the page's cached copy answers — that is what makes returning to a
 * conversation cost no blank frame — and when there is none the answer is
 * nothing, never the conversation of the agent the reader left. That last
 * rule matters as much as the cache: the state is dropped by an effect, so
 * one render still holds the previous agent's messages under the new name.
 */
export function shownConversationOf(
  activeAgentId: string | null,
  liveAgentId: string | null,
  liveConversation: StellaConversationState | null,
  liveSessionId: string | null,
  cache: ConversationCache,
): ShownConversation {
  if (activeAgentId === null) {
    return {
      conversation: null,
      agentId: null,
      sessionId: null,
      settled: false,
    };
  }
  if (liveAgentId === activeAgentId) {
    return {
      conversation: liveConversation,
      agentId: liveAgentId,
      sessionId: liveSessionId,
      settled: true,
    };
  }
  const cached = cache.get(activeAgentId);
  if (cached === undefined) {
    return {
      conversation: null,
      agentId: null,
      sessionId: null,
      settled: false,
    };
  }
  return {
    conversation: cached.conversation,
    agentId: activeAgentId,
    sessionId: cached.sessionId,
    settled: false,
  };
}
