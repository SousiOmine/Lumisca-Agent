import {
  conversationEntriesOf,
  stellaEntriesOf,
  stellaEntryCursorOf,
} from "../agent/stella-stream.ts";
import type { AgentMessage } from "../domain/message.ts";

import type { StellaEntry } from "../domain/stella-conversation.ts";
import { CoreError } from "../errors.ts";
import { readTranscriptPage } from "../session/transcript-pager.ts";
import {
  messageCursorOf,
  startsTranscriptTurn,
  type WindowPage,
  type WindowQuery,
} from "../session/transcript-window.ts";
import type { ContextUsageSummary } from "../shared/context-usage.ts";
import { summarizeContextUsage } from "../shared/context-usage.ts";
import type { SessionServiceDeps } from "./session-deps.ts";

type Deps = Pick<SessionServiceDeps, "messages" | "pool" | "sessions">;

/**
 * Reading a session's history: one window at a time from the store, plus the
 * rows a run has appended but not written yet.
 *
 * A session agent holds only the model's view in memory, so a long
 * conversation is read from the store. The live tail matters because the
 * client draws what is happening now: a window read mid-run must include the
 * prompt and the rows that have not been persisted.
 */
export class SessionTranscript {
  constructor(private readonly deps: Deps) {}

  /** One window of a session's transcript, read from the store. */
  readTranscript(
    id: string,
    query: WindowQuery,
  ): WindowPage<AgentMessage> | undefined {
    const agent = this.deps.pool.get(id);
    if (agent === undefined) return undefined;
    const page = readTranscriptPage(this.deps.messages, agent.agentId, query, {
      startsWindow: (message) => startsTranscriptTurn(message),
      rows: "all",
      project: (row) => [
        { item: row.message, cursor: messageCursorOf(row.message) },
      ],
    });
    return (query.older ?? null) === null ? this.withLiveTail(id, page) : page;
  }

  /** One window of a stella conversation, in the shape its client draws. */
  readStellaConversation(
    id: string,
    query: WindowQuery,
  ): WindowPage<StellaEntry> | undefined {
    const agent = this.deps.pool.get(id);
    if (agent === undefined) return undefined;
    const page = this.stellaPage(agent.agentId, query);
    if ((query.older ?? null) !== null) return page;
    // The prompt of a run in flight is not written yet; a conversation read
    // mid-run must still show it (see unpersistedTail).
    const tail = conversationEntriesOf(this.unpersistedTail(id));
    return tail.length === 0
      ? page
      : { items: page.items.concat(tail), older: page.older };
  }

  /** One window of a conversation that is NOT open, read from the store
   * alone.
   *
   * A disabled agent's conversation is the case: it is served read-only, so
   * no agent exists to ask for the rows a run has not written — and, because
   * disabling aborts the run, there are none. Everything else is the same
   * projection and the same paging as the open read, so a client cannot tell
   * which one answered it.
   */
  readStellaConversationFromStore(
    id: string,
    query: WindowQuery,
  ): WindowPage<StellaEntry> {
    return this.stellaPage(this.mainAgentIdOf(id), query);
  }

  /** The stored page of a conversation, before the live tail.
   *
   * Project first, page over the projection: a page must count what the
   * conversation shows, not what the model's history holds (most of a
   * stella transcript is tool traffic nobody sees). `rows: "conversation"`
   * is what makes the page a count of those entries — without it a page of
   * 40 filled up on tool rows during a run and projected to nothing.
   */
  private stellaPage(
    agentId: string,
    query: WindowQuery,
  ): WindowPage<StellaEntry> {
    return readTranscriptPage(this.deps.messages, agentId, query, {
      startsWindow: () => true,
      rows: "conversation",
      project: (row) =>
        stellaEntriesOf(row.message).map((entry) => ({
          item: entry,
          cursor: stellaEntryCursorOf(entry),
        })),
    });
  }

  /** The session's context usage over the WHOLE transcript. */
  getSessionUsage(id: string): ContextUsageSummary {
    return summarizeContextUsage(
      this.deps.messages.usageRows(this.mainAgentIdOf(id)),
    );
  }

  /** The agent a session's transcript belongs to. Read from the session row
   * rather than from an open agent: a disabled conversation is served from
   * the store, with nothing open. */
  private mainAgentIdOf(id: string): string {
    const session = this.deps.sessions.get(id);
    if (session === undefined) {
      throw new CoreError(`Session not found: ${id}`, "not_found");
    }
    return session.mainAgentId;
  }

  /** Append the rows a run has appended but not yet written. */
  private withLiveTail(
    id: string,
    page: WindowPage<AgentMessage>,
  ): WindowPage<AgentMessage> {
    const tail = this.unpersistedTail(id);
    return tail.length === 0
      ? page
      : { items: page.items.concat(tail), older: page.older };
  }

  /** The rows of one session the store does NOT hold yet. */
  private unpersistedTail(id: string): AgentMessage[] {
    const agent = this.deps.pool.get(id);
    if (agent === undefined) return [];
    const view = agent.messages;
    const count = agent.persistedCount;
    return count >= view.length ? [] : view.slice(count);
  }
}
