import type { AgentMessage } from "../ai/types.ts";
import { stellaEntryCursorOf, stellaEntryOf } from "../agent/stella-stream.ts";
import type { ContextUsageSummary } from "../shared/context-usage.ts";
import { summarizeContextUsage } from "../shared/context-usage.ts";
import {
  messageCursorOf,
  startsTranscriptTurn,
  type WindowPage,
  type WindowQuery,
} from "../session/transcript-window.ts";
import { readTranscriptPage } from "../session/transcript-pager.ts";
import type { StellaEntry } from "../domain/stella-conversation.ts";
import type { SessionServiceDeps } from "./session-deps.ts";

type Deps = Pick<SessionServiceDeps, "messages" | "pool">;

/** The conversation entries a set of stored rows projects to, oldest
 * first: one projection shared by the window reader and `history_search`. */
function entriesOf(messages: readonly AgentMessage[]): StellaEntry[] {
  const entries: StellaEntry[] = [];
  for (const message of messages) {
    const entry = stellaEntryOf(message);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

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
    if (this.deps.pool.get(id) === undefined) return undefined;
    const page = readTranscriptPage(this.deps.messages, id, query, {
      startsWindow: (message) => startsTranscriptTurn(message),
      rows: "all",
      project: (row) => ({
        item: row.message,
        cursor: messageCursorOf(row.message),
      }),
    });
    return (query.older ?? null) === null ? this.withLiveTail(id, page) : page;
  }

  /** One window of a stella conversation, in the shape its client draws. */
  readStellaConversation(
    id: string,
    query: WindowQuery,
  ): WindowPage<StellaEntry> | undefined {
    if (this.deps.pool.get(id) === undefined) return undefined;
    // Project first, page over the projection: a page must count what the
    // conversation shows, not what the model's history holds (most of a
    // stella transcript is tool traffic nobody sees). `rows:
    // "conversation"` is what makes the page a count of those entries —
    // without it a page of 40 filled up on tool rows during a run and
    // projected to nothing.
    const page = readTranscriptPage(this.deps.messages, id, query, {
      startsWindow: () => true,
      rows: "conversation",
      project: (row) => {
        const entry = stellaEntryOf(row.message);
        return entry === null
          ? undefined
          : { item: entry, cursor: stellaEntryCursorOf(entry) };
      },
    });
    if ((query.older ?? null) !== null) return page;
    // The prompt of a run in flight is not written yet; a conversation read
    // mid-run must still show it (see unpersistedTail).
    const tail = entriesOf(this.unpersistedTail(id));
    return tail.length === 0
      ? page
      : { items: page.items.concat(tail), older: page.older };
  }

  /** The session's context usage over the WHOLE transcript. */
  getSessionUsage(id: string): ContextUsageSummary {
    return summarizeContextUsage(this.deps.messages.usageRows(id));
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
