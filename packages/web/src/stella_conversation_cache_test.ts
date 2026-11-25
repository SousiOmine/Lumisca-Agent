/**
 * Which conversation the transcript draws.
 *
 * Selecting an agent starts a server read, and the state of the conversation
 * the reader just left is still in hand for that frame. These cases pin the
 * answer: the chosen agent's live state when there is one, the page's cached
 * copy for the agent while the read is in flight, and nothing — never another
 * agent's messages — when this page has never had it.
 */
import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  CONVERSATION_CACHE_SIZE,
  ConversationCache,
  shownConversationOf,
} from "./stella-conversation-cache.ts";
import type { StellaConversationState } from "./stella-state.ts";

function state(agentName: string): StellaConversationState {
  return {
    entries: [],
    older: null,
    running: false,
    activity: null,
    liveUi: null,
    questions: [],
    handover: null,
    envRequest: null,
    shareRequest: null,
    shares: [],
    agentName,
    disabled: false,
    model: null,
    thinking: null,
  };
}

test("ConversationCache: what was remembered comes back with its session", () => {
  const cache = new ConversationCache();
  assertEquals(cache.get("a"), undefined);
  cache.remember("a", state("A"), "session-a");
  assertEquals(cache.get("a")?.conversation.agentName, "A");
  assertEquals(cache.get("a")?.sessionId, "session-a");
});

test("ConversationCache: the oldest conversation goes when the bound is crossed", () => {
  const cache = new ConversationCache();
  for (let i = 0; i < CONVERSATION_CACHE_SIZE + 1; i++) {
    cache.remember(`agent-${i}`, state(`agent-${i}`), null);
  }
  assertEquals(cache.get("agent-0"), undefined);
  assertEquals(
    cache.get(`agent-${CONVERSATION_CACHE_SIZE}`)?.conversation.agentName,
    `agent-${CONVERSATION_CACHE_SIZE}`,
  );
});

test("ConversationCache: writing an agent again makes it the newest", () => {
  const cache = new ConversationCache();
  cache.remember("a", state("A"), null);
  cache.remember("b", state("B"), null);
  // Touch A, then add enough rows to cross the bound: B is the oldest now.
  cache.remember("a", state("A again"), null);
  for (let i = 0; i < CONVERSATION_CACHE_SIZE - 1; i++) {
    cache.remember(`extra-${i}`, state(`extra-${i}`), null);
  }
  assertEquals(cache.get("a")?.conversation.agentName, "A again");
  assertEquals(cache.get("b"), undefined);
});

test("shownConversationOf: no agent is no conversation", () => {
  const cache = new ConversationCache();
  cache.remember("a", state("A"), "session-a");
  const shown = shownConversationOf(
    null,
    "a",
    state("live A"),
    "session-a",
    cache,
  );
  assertEquals(shown, {
    conversation: null,
    agentId: null,
    sessionId: null,
    settled: false,
  });
});

test("shownConversationOf: the live state wins when it is this agent's", () => {
  const cache = new ConversationCache();
  cache.remember("a", state("cached A"), "session-a");
  const shown = shownConversationOf(
    "a",
    "a",
    state("live A"),
    "session-a",
    cache,
  );
  assertEquals(shown.conversation?.agentName, "live A");
  assertEquals(shown.agentId, "a");
  assertEquals(shown.settled, true);
});

test("shownConversationOf: a cached copy answers until the read lands", () => {
  const cache = new ConversationCache();
  cache.remember("b", state("cached B"), "session-b");
  // The reader left A: the live state is still A's for one render.
  const shown = shownConversationOf(
    "b",
    "a",
    state("live A"),
    "session-a",
    cache,
  );
  assertEquals(shown.conversation?.agentName, "cached B");
  assertEquals(shown.agentId, "b");
  assertEquals(shown.sessionId, "session-b");
  assertEquals(shown.settled, false);
});

test("shownConversationOf: without a cached copy, the previous agent is not shown", () => {
  const cache = new ConversationCache();
  const shown = shownConversationOf(
    "b",
    "a",
    state("live A"),
    "session-a",
    cache,
  );
  assertEquals(shown, {
    conversation: null,
    agentId: null,
    sessionId: null,
    settled: false,
  });
});
