import { assertEquals, assertNotEquals } from "@std/assert";
import type { StellaEvent } from "./types.ts";
import {
  applyStellaEvent,
  emptyStellaState,
  entryKey,
  prependOlderEntries,
  type StellaConversationState,
  stellaStateOf,
} from "./stella-state.ts";

function entry(
  role: "user" | "assistant",
  text: string,
  timestamp: number,
  cards: string[] = [],
) {
  return { role, text, cards, attachments: [], images: [], timestamp };
}

function state(
  overrides: Partial<StellaConversationState> = {},
): StellaConversationState {
  return { ...emptyStellaState("Aide"), ...overrides };
}

Deno.test("stellaStateOf: a snapshot becomes the conversation", () => {
  const snapshot = {
    entries: [entry("user", "こんにちは", 1)],
    older: "cursor-1",
    running: true,
    questions: [],
    handover: null,
    error: "last failure",
    agentName: "Aide",
    sessionId: "s1",
    rev: 3,
  };
  assertEquals(stellaStateOf(snapshot), {
    entries: [entry("user", "こんにちは", 1)],
    // The cursor travels with the window: the conversation keeps its way
    // back through the history before it.
    older: "cursor-1",
    streamingText: "",
    running: true,
    questions: [],
    handover: null,
    error: "last failure",
    agentName: "Aide",
  });
});

Deno.test("applyStellaEvent: an entry is appended and the stream cleared", () => {
  const before = state({ streamingText: "こん" });
  const next = applyStellaEvent(before, {
    type: "entry",
    entry: entry("assistant", "こんにちは", 2),
  })!;
  assertEquals(next.entries, [entry("assistant", "こんにちは", 2)]);
  assertEquals(next.streamingText, "");
});

Deno.test("applyStellaEvent: the same message twice replaces in place", () => {
  // The server sends a synthetic start/end pair for an injected message and
  // the placeholder plus the final copy for a reply; a re-read snapshot can
  // overlap the live events. An entry must never appear twice, and it must
  // not move to the end when a later copy arrives.
  let current = state();
  current = applyStellaEvent(current, {
    type: "entry",
    entry: entry("user", "A", 1),
  })!;
  current = applyStellaEvent(current, {
    type: "entry",
    entry: entry("assistant", "B", 2),
  })!;
  current = applyStellaEvent(current, {
    type: "entry",
    entry: entry("user", "A", 1),
  })!;
  assertEquals(current.entries.map((e) => e.text), ["A", "B"]);
  assertEquals(entryKey(current.entries[0]!), "user:1::0:A");
});

Deno.test("applyStellaEvent: deltas accumulate and are dropped at the end", () => {
  let current = state({ running: true });
  current = applyStellaEvent(current, { type: "delta", delta: "あ" })!;
  current = applyStellaEvent(current, { type: "delta", delta: "い" })!;
  assertEquals(current.streamingText, "あい");
  current = applyStellaEvent(current, { type: "agent_end" })!;
  assertEquals(current.streamingText, "");
  assertEquals(current.running, false);
});

Deno.test("applyStellaEvent: the run state and its error", () => {
  let current = state();
  current = applyStellaEvent(current, { type: "agent_start" })!;
  assertEquals(current.running, true);
  current = applyStellaEvent(current, {
    type: "error",
    message: "boom",
  })!;
  assertEquals(current.error, "boom");
  // A new run clears the previous failure.
  current = applyStellaEvent(current, { type: "agent_start" })!;
  assertEquals(current.error, undefined);
});

Deno.test("applyStellaEvent: questions and the hand-over replace wholesale", () => {
  const questions = [{
    toolCallId: "t1",
    questions: [{ id: "q1", question: "どれ？", options: [] }],
  }];
  let current = state();
  current = applyStellaEvent(current, { type: "questions", questions })!;
  assertEquals(current.questions, questions);
  assertEquals(
    applyStellaEvent(current, { type: "questions", questions }),
    null,
  );

  const handover = {
    toolCallId: "t2",
    reason: "ログイン",
    instructions: null,
  };
  current = applyStellaEvent(current, { type: "handover", handover })!;
  assertEquals(current.handover, handover);
  assertEquals(applyStellaEvent(current, { type: "handover", handover }), null);
  current = applyStellaEvent(current, { type: "handover", handover: null })!;
  assertEquals(current.handover, null);
});

Deno.test("applyStellaEvent: no-ops keep the previous object", () => {
  // The hook writes only when the reducer returns a new object, so a
  // memoized view is not re-rendered by a repeated frame.
  const idle = state();
  assertEquals(applyStellaEvent(idle, { type: "agent_end" }), null);
  const duplicate: StellaEvent = {
    type: "entry",
    entry: entry("assistant", "A", 1),
  };
  const once = applyStellaEvent(idle, duplicate)!;
  assertEquals(applyStellaEvent(once, duplicate), null);
});

Deno.test("stellaStateOf: a re-read snapshot merges into paged history", () => {
  // The client paged back and holds history the newest window does not: the
  // snapshot must add what the socket missed, not replace what the reader
  // loaded.
  const first = entry("user", "最初", 1);
  const second = entry("assistant", "返答", 2);
  const third = entry("user", "続き", 3);
  const current = state({
    entries: [first, second, third],
    older: "cursor-old",
  });

  const merged = stellaStateOf({
    entries: [second, third, entry("assistant", "新しい返答", 4)],
    older: "cursor-newer",
    running: false,
    questions: [],
    handover: null,
    agentName: "Aide",
    sessionId: "s1",
    rev: 9,
  }, current);

  assertEquals(merged.entries.map(entryKey), [
    entryKey(first),
    entryKey(second),
    entryKey(third),
    entryKey(entry("assistant", "新しい返答", 4)),
  ]);
  // The client keeps the way back it already had: the window that arrived
  // started inside what it holds.
  assertEquals(merged.older, "cursor-old");
});

Deno.test("stellaStateOf: a window that shares nothing replaces the state", () => {
  const current = state({
    entries: [entry("user", "古い", 1)],
    older: "stale-cursor",
  });
  const merged = stellaStateOf({
    entries: [entry("user", "新しい", 5)],
    older: "fresh-cursor",
    running: false,
    questions: [],
    handover: null,
    agentName: "Aide",
    sessionId: "s1",
    rev: 9,
  }, current);
  assertEquals(merged.entries.map((e) => e.text), ["新しい"]);
  // The held cursor names a position in a conversation the client is no
  // longer at the end of: the window's cursor takes over.
  assertEquals(merged.older, "fresh-cursor");
});

Deno.test("prependOlderEntries: a page goes in front; an empty one ends the walk", () => {
  const current = state({
    entries: [entry("user", "後", 3)],
    older: "cursor-b",
  });
  const next = prependOlderEntries(
    current,
    [entry("user", "前", 1), entry("assistant", "返答", 2)],
    "cursor-a",
  );
  assertEquals(next.entries.map((e) => e.timestamp), [1, 2, 3]);
  assertEquals(next.older, "cursor-a");

  // Nothing new means the beginning was reached: the client must not ask for
  // the same page again.
  const repeated = prependOlderEntries(current, current.entries, "cursor-b");
  assertEquals(repeated.entries, current.entries);
  assertEquals(repeated.older, null);
});

Deno.test("applyStellaEvent: two sends in one millisecond stay two entries", () => {
  // Regression: the dedup key was role + timestamp (+ the first attachment's
  // name). The clock is a millisecond, so a burst of sends — or a server that
  // stamps a batch with one tick — produced one key for two DIFFERENT
  // messages, and the second overwrote the first: the conversation silently
  // lost a line the user had just typed.
  const first = entry("user", "連続 1", 1000);
  const second = entry("user", "連続 2", 1000);
  assertNotEquals(entryKey(first), entryKey(second));

  let current = state();
  current = applyStellaEvent(current, { type: "entry", entry: first })!;
  current = applyStellaEvent(current, { type: "entry", entry: second })!;
  assertEquals(current.entries.map((e) => e.text), ["連続 1", "連続 2"]);
});

Deno.test("applyStellaEvent: the same message announced twice is one entry", () => {
  // The other half of the same rule: the synthetic start/end pair (and the
  // snapshot that repeats an event) must still collapse.
  const message = entry("user", "同じ", 1000);
  let current = state();
  current = applyStellaEvent(current, { type: "entry", entry: message })!;
  current = applyStellaEvent(current, {
    type: "entry",
    entry: { ...message },
  })!;
  assertEquals(current.entries.length, 1);
});
