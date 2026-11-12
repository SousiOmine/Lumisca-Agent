import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  applyStellaEvent,
  emptyStellaState,
  entryKey,
  prependOlderEntries,
  type StellaConversationState,
  stellaStateOf,
  transcriptEntries,
} from "./stella-state.ts";
import type { StellaEvent, ThinkingLevel } from "./types.ts";

function entry(
  role: "user" | "assistant",
  text: string,
  timestamp: number,
  card: string | null = null,
) {
  const segments = text.length === 0 ? [] : [{ type: "text" as const, text }];
  return {
    role,
    text,
    segments:
      card === null
        ? segments
        : [...segments, { type: "card" as const, markup: card }],
    attachments: [],
    files: [],
    timestamp,
  };
}

function state(
  overrides: Partial<StellaConversationState> = {},
): StellaConversationState {
  return { ...emptyStellaState("Aide"), ...overrides };
}

const thinkingLevel: ThinkingLevel = "high";

Deno.test("stellaStateOf: a snapshot becomes the conversation", () => {
  const snapshot = {
    entries: [entry("user", "こんにちは", 1)],
    older: "cursor-1",
    running: true,
    questions: [],
    handover: null,
    envRequest: null,
    shares: [],
    error: "last failure",
    agentName: "Aide",
    sessionId: "s1",
    model: { provider: "faux", modelId: "model" },
    thinkingLevel,
    thinkingLevels: ["off", "low", "high"] as ThinkingLevel[],
    rev: 3,
  };
  assertEquals(stellaStateOf(snapshot), {
    entries: [entry("user", "こんにちは", 1)],
    // The cursor travels with the window: the conversation keeps its way
    // back through the history before it.
    older: "cursor-1",
    running: true,
    liveCard: null,
    questions: [],
    handover: null,
    envRequest: null,
    shares: [],
    error: "last failure",
    agentName: "Aide",
    model: { provider: "faux", modelId: "model" },
    thinking: { level: "high", levels: ["off", "low", "high"] },
  });
});

Deno.test("stella: an env request is state a reconnect can still answer", () => {
  // `env_request` events are not replayed, so the snapshot is the only thing
  // that can reopen the dialog for a client that was away when it opened.
  const request = {
    toolCallId: "t1",
    name: "OPENAI_API_KEY",
    exists: false,
    expiresAt: 1_000,
  };
  const next = applyStellaEvent(state(), {
    type: "env_request",
    request,
  })!;
  assertEquals(next.envRequest, request);
  // The end of the request (stored, declined or expired) closes the dialog.
  const closed = applyStellaEvent(next, {
    type: "env_request",
    request: null,
  })!;
  assertEquals(closed.envRequest, null);
  // The same request twice changes nothing (a duplicate event must not
  // re-render, and above all must not reset the field the user is typing in).
  assertEquals(applyStellaEvent(next, { type: "env_request", request }), null);
});

Deno.test("stellaStateOf: a model without thinking levels shows no rail", () => {
  // The rail is drawn only when the model has a choice to offer; a snapshot
  // from a server that predates the field must not invent one.
  const snapshot = {
    entries: [],
    older: null,
    running: false,
    questions: [],
    handover: null,
    envRequest: null,
    agentName: "Aide",
    sessionId: "s1",
    model: { provider: "faux", modelId: "model" },
    rev: 1,
  };
  assertEquals(stellaStateOf(snapshot).thinking, { level: "off", levels: [] });
});

Deno.test("applyStellaEvent: an entry is appended", () => {
  const next = applyStellaEvent(state(), {
    type: "entry",
    entry: entry("assistant", "こんにちは", 2),
  })!;
  assertEquals(next.entries, [entry("assistant", "こんにちは", 2)]);
});

Deno.test("applyStellaEvent: the same message twice is one entry", () => {
  // The server announces an injected message twice (a synthetic start/end
  // pair) and a client that reconnects reads the same window again: the same
  // message must never appear twice, and a second copy changes nothing.
  const message = entry("assistant", "こんにちは", 2);
  const once = applyStellaEvent(state(), { type: "entry", entry: message })!;
  assertEquals(applyStellaEvent(once, { type: "entry", entry: message }), null);
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
  assertEquals(
    current.entries.map((e) => e.text),
    ["A", "B"],
  );
  assertEquals(entryKey(current.entries[0]!), "user:1:::::A");
});

Deno.test("applyStellaEvent: the run ends", () => {
  let current = state({ running: true });
  current = applyStellaEvent(current, { type: "agent_end" })!;
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
  const questions = [
    {
      toolCallId: "t1",
      questions: [{ id: "q1", question: "どれ？", options: [] }],
    },
  ];
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
    expiresAt: 1_700_000_000_000,
  };
  current = applyStellaEvent(current, { type: "handover", handover })!;
  assertEquals(current.handover, handover);
  assertEquals(applyStellaEvent(current, { type: "handover", handover }), null);
  // A re-delivered request with a DIFFERENT deadline is a different wait:
  // the pane's countdown must follow it rather than keep the old one.
  assertEquals(
    applyStellaEvent(current, {
      type: "handover",
      handover: { ...handover, expiresAt: 1_700_000_900_000 },
    })?.handover?.expiresAt,
    1_700_000_900_000,
  );
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

  const merged = stellaStateOf(
    {
      entries: [second, third, entry("assistant", "新しい返答", 4)],
      older: "cursor-newer",
      running: false,
      questions: [],
      handover: null,
      envRequest: null,
      agentName: "Aide",
      sessionId: "s1",
      model: { provider: "faux", modelId: "model" },
      rev: 9,
    },
    current,
  );

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

Deno.test("stellaStateOf: an empty window keeps the conversation it holds", () => {
  // A snapshot can hold no entries and still not be the beginning of the
  // conversation: a run whose visible entries are all older than the window.
  // Replacing the state with it would empty a screen that was showing the
  // conversation — and, because the cursor went with it, leave no way back.
  const first = entry("user", "最初", 1);
  const current = state({ entries: [first], older: "cursor-old" });
  const merged = stellaStateOf(
    {
      entries: [],
      older: null,
      running: true,
      questions: [],
      handover: null,
      envRequest: null,
      agentName: "Aide",
      sessionId: "s1",
      model: { provider: "faux", modelId: "model" },
      rev: 9,
    },
    current,
  );
  assertEquals(merged.entries.map(entryKey), [entryKey(first)]);
  assertEquals(merged.older, "cursor-old");
  // The run state still comes from the snapshot: that is what it is for.
  assertEquals(merged.running, true);
});

Deno.test("stellaStateOf: a window that shares nothing replaces the state", () => {
  const current = state({
    entries: [entry("user", "古い", 1)],
    older: "stale-cursor",
  });
  const merged = stellaStateOf(
    {
      entries: [entry("user", "新しい", 5)],
      older: "fresh-cursor",
      running: false,
      questions: [],
      handover: null,
      envRequest: null,
      agentName: "Aide",
      sessionId: "s1",
      model: { provider: "faux", modelId: "model" },
      rev: 9,
    },
    current,
  );
  assertEquals(
    merged.entries.map((e) => e.text),
    ["新しい"],
  );
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
  assertEquals(
    next.entries.map((e) => e.timestamp),
    [1, 2, 3],
  );
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
  assertEquals(
    current.entries.map((e) => e.text),
    ["連続 1", "連続 2"],
  );
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

Deno.test("prependOlderEntries: a page never inserts live entries above", () => {
  // Regression: the page is asked for by cursor, but the conversation keeps
  // growing while the answer is in flight. Prepending everything the client
  // lacked put a reply that had just arrived at the TOP of the conversation;
  // the live stream then appended the same entry again, so it showed twice —
  // and a reload (the server holds it once) removed the duplicate.
  let current = state({
    entries: [entry("user", "今の依頼", 5000)],
    older: "cursor-1",
  });
  current = prependOlderEntries(
    current,
    [
      entry("user", "今の依頼", 5000), // already held: the page stops here
      entry("assistant", "作業中の返事", 6000), // newer than the live edge
    ],
    "cursor-0",
  );
  assertEquals(
    current.entries.map((e) => e.text),
    ["今の依頼"],
  );
});

Deno.test("prependOlderEntries: an entry newer than the edge is never added", () => {
  // Even without an overlap to stop at, an entry newer than what the client
  // holds belongs to the live stream.
  const current = prependOlderEntries(
    state({ entries: [entry("user", "今の依頼", 5000)] }),
    [entry("assistant", "まだ届いていない返事", 9000)],
    "cursor-0",
  );
  assertEquals(
    current.entries.map((e) => e.text),
    ["今の依頼"],
  );
});

Deno.test("stella: a card being written grows, and the entry replaces it", () => {
  let current = state({ running: true });
  current = applyStellaEvent(current, {
    type: "card_delta",
    toolCallId: "call-1",
    delta: "<Card><Text>",
  })!;
  current = applyStellaEvent(current, {
    type: "card_delta",
    toolCallId: "call-1",
    delta: "進めますか。</Text></Card>",
  })!;

  assertEquals(current.liveCard, {
    toolCallId: "call-1",
    markup: "<Card><Text>進めますか。</Text></Card>",
  });

  // The finished message carries the whole card; what was drawn from the
  // fragments must not stay beside it.
  current = applyStellaEvent(current, {
    type: "entry",
    entry: entry("assistant", "", 5, "<Card><Text>進めますか。</Text></Card>"),
  })!;
  assertEquals(current.liveCard, null);
  assertEquals(current.entries.length, 1);
});

Deno.test("stella: a narration card is dropped when its message ends", () => {
  // A message that stopped to call a tool is not a reply (see the server's
  // projection): the card it drew has nowhere to land, and `card_end` clears
  // it. Waiting for the next entry would leave it up for the whole tool run.
  let current = applyStellaEvent(state(), {
    type: "card_delta",
    toolCallId: "text-1",
    delta: "<Card><Text>途中</Text></Card>",
  })!;
  assert(current.liveCard !== null);

  current = applyStellaEvent(current, { type: "card_end" })!;
  assertEquals(current.liveCard, null);
  // Nothing was drawn, so the same event again changes nothing.
  assertEquals(applyStellaEvent(current, { type: "card_end" }), null);
});

Deno.test("stella: a card of another call starts over, and the run clears it", () => {
  let current = state({ running: true });
  current = applyStellaEvent(current, {
    type: "card_delta",
    toolCallId: "call-1",
    delta: "<Card><Text>a</Text></Card>",
  })!;
  current = applyStellaEvent(current, {
    type: "card_delta",
    toolCallId: "call-2",
    delta: "<Card><Text>b",
  })!;
  assertEquals(current.liveCard, {
    toolCallId: "call-2",
    markup: "<Card><Text>b",
  });

  current = applyStellaEvent(current, { type: "agent_end" })!;
  assertEquals(current.liveCard, null);
  assertEquals(current.running, false);
});

Deno.test("stella: a snapshot is the finished conversation, so it draws no live card", () => {
  const snapshot = {
    entries: [entry("user", "こんにちは", 1)],
    older: null,
    running: true,
    questions: [],
    handover: null,
    envRequest: null,
    agentName: "Aide",
    sessionId: "s1",
    model: { provider: "faux", modelId: "model" },
    rev: 3,
  };

  assertEquals(stellaStateOf(snapshot).liveCard, null);
});

Deno.test("entryKey: a routine's prompt and the same words typed differ", () => {
  // Two entries of one millisecond must not collapse: the routine's name is
  // part of which message this is.
  const typed = {
    role: "user" as const,
    text: "確認して",
    segments: [{ type: "text" as const, text: "確認して" }],
    attachments: [],
    files: [],
    timestamp: 5,
  };
  assert(entryKey(typed) !== entryKey({ ...typed, routine: "毎朝の確認" }));
});

Deno.test("transcriptEntries: a routine's prompt is not drawn", () => {
  // The words are the routine's instruction plus guidance written for the
  // model, so the transcript shows only what the run answered. The entry is
  // kept in the state (identity, the agent list's second line), which is why
  // the filter happens on the way to the drawing.
  const typed = { ...entry("user", "確認して", 1) };
  const prompt = { ...entry("user", "毎朝の確認をして", 2), routine: "毎朝" };
  const reply = entry("assistant", "異常なし", 3);
  assertEquals(transcriptEntries([typed, prompt, reply]), [typed, reply]);
  // An entry with nothing to skip is returned in the same order.
  assertEquals(transcriptEntries([typed, reply]), [typed, reply]);
  assertEquals(transcriptEntries([]), []);
});
