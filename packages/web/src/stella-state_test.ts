import { assertEquals } from "@std/assert";
import type { StellaEvent } from "./types.ts";
import {
  applyStellaEvent,
  emptyStellaState,
  entryKey,
  type StellaConversationState,
  stellaStateOf,
} from "./stella-state.ts";

function entry(
  role: "user" | "assistant",
  text: string,
  timestamp: number,
  cards: string[] = [],
) {
  return { role, text, cards, attachments: [], timestamp };
}

function state(
  overrides: Partial<StellaConversationState> = {},
): StellaConversationState {
  return { ...emptyStellaState("Aide"), ...overrides };
}

Deno.test("stellaStateOf: a snapshot becomes the conversation", () => {
  const snapshot = {
    entries: [entry("user", "こんにちは", 1)],
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
  assertEquals(entryKey(current.entries[0]!), "user:1:");
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
