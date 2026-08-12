import { assertEquals } from "@std/assert";
import { applyEvent, filterRemoved, mergeMessages } from "./events.ts";
import { type AgentMessage, isViewRunning, type SessionView } from "./types.ts";

function message(
  role: AgentMessage["role"],
  timestamp: number,
  text = "hello",
): AgentMessage {
  return { role, timestamp, content: [{ type: "text", text }] } as AgentMessage;
}

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    info: {
      id: "s1",
      workspaceId: "w1",
      name: "s",
      modelProvider: "p",
      modelId: "m",
      createdAt: 1,
      updatedAt: 1,
    },
    messages: [],
    streamingText: "",
    runningTools: new Map(),
    removed: new Set(),
    ...overrides,
  };
}

Deno.test("events: user message is appended on start, replaced on end", () => {
  let v = view();
  v = applyEvent(
    {
      type: "message_start",
      sessionId: "s1",
      message: message("user", 100),
    },
    v,
  )!;
  assertEquals(v.messages.length, 1);

  // Same timestamp, final copy: replace, not append.
  v = applyEvent(
    {
      type: "message_end",
      sessionId: "s1",
      message: message("user", 100, "final"),
    },
    v,
  )!;
  assertEquals(v.messages.length, 1);
  const finalMessage = v.messages[0] as { content: Array<{ text: string }> };
  assertEquals(finalMessage.content[0]!.text, "final");

  // End without a preceding start: append.
  const v2 = applyEvent(
    { type: "message_end", sessionId: "s1", message: message("user", 200) },
    view(),
  )!;
  assertEquals(v2.messages.length, 1);
});

Deno.test("events: assistant message_end never duplicates after a resync", () => {
  // The resync fetch already contains the message; the late message_end
  // event must not append a second copy.
  const existing = view({ messages: [message("assistant", 100, "done")] });
  const v = applyEvent(
    {
      type: "message_end",
      sessionId: "s1",
      message: message("assistant", 100, "done"),
    },
    existing,
  )!;
  assertEquals(v.messages.length, 1);
  assertEquals(v.streamingText, "");
});

Deno.test("events: user message_start never duplicates (steered while running)", () => {
  // A message sent while the agent runs is announced immediately by the
  // server and re-emitted when the running loop drains it; the second
  // emission has the same role + timestamp and must not append a copy.
  const m = message("user", 100, "stop");
  let v = view();
  v = applyEvent({ type: "message_start", sessionId: "s1", message: m }, v)!;
  assertEquals(v.messages.length, 1);
  v = applyEvent({ type: "message_start", sessionId: "s1", message: m }, v)!;
  assertEquals(v.messages.length, 1);
  v = applyEvent({ type: "message_end", sessionId: "s1", message: m }, v)!;
  assertEquals(v.messages.length, 1);
});

Deno.test("events: assistant stream accumulates deltas and clears on start", () => {
  let v = view();
  v = applyEvent(
    {
      type: "message_start",
      sessionId: "s1",
      message: message("assistant", 100),
    },
    v,
  )!;
  v = applyEvent(
    { type: "message_delta", sessionId: "s1", delta: "Hel" },
    v,
  )!;
  v = applyEvent(
    { type: "message_delta", sessionId: "s1", delta: "lo" },
    v,
  )!;
  assertEquals(v.streamingText, "Hello");
  v = applyEvent(
    {
      type: "message_end",
      sessionId: "s1",
      message: message("assistant", 100),
    },
    v,
  )!;
  assertEquals(v.streamingText, "");
});

Deno.test("events: tool start/end track running tools", () => {
  let v = view();
  v = applyEvent(
    {
      type: "tool_start",
      sessionId: "s1",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
    },
    v,
  )!;
  assertEquals(v.runningTools.get("t1"), "bash");
  v = applyEvent(
    {
      type: "tool_end",
      sessionId: "s1",
      toolCallId: "t1",
      toolName: "bash",
      result: {},
      isError: false,
    },
    v,
  )!;
  assertEquals(v.runningTools.size, 0);
});

Deno.test("events: errors are set on session_error and cleared on agent_start", () => {
  let v = view();
  v = applyEvent(
    { type: "session_error", sessionId: "s1", message: "boom" },
    v,
  )!;
  assertEquals(v.error, "boom");
  v = applyEvent({ type: "agent_start", sessionId: "s1" }, v)!;
  assertEquals(v.error, undefined);
  assertEquals(isViewRunning(v), true);
  v = applyEvent({ type: "agent_end", sessionId: "s1" }, v)!;
  assertEquals(isViewRunning(v), false);
});

Deno.test("events: other sessions and non-view events are ignored", () => {
  const v = view();
  assertEquals(
    applyEvent({ type: "message_delta", sessionId: "other", delta: "x" }, v),
    null,
  );
  assertEquals(
    applyEvent(
      {
        type: "session_created",
        session: v.info,
      },
      v,
    ),
    null,
  );
  // No-op events return the same view reference.
  assertEquals(
    applyEvent({ type: "agent_end", sessionId: "s1" }, v),
    null,
  );
});

Deno.test("events: mergeMessages is idempotent and order-preserving", () => {
  const existing = [message("user", 100), message("assistant", 200)];
  const fetched = [
    message("user", 100),
    message("assistant", 200),
    message("assistant", 300),
  ];
  const merged = mergeMessages(existing, fetched);
  assertEquals(merged.length, 3);
  assertEquals(merged[2]!.timestamp, 300);
  // Running the merge again with the same inputs must not grow the list.
  assertEquals(mergeMessages(merged, fetched).length, 3);
});

Deno.test("events: messages_truncated drops the exact removed messages", () => {
  let v = view({
    messages: [
      message("user", 100),
      message("assistant", 100), // same millisecond as the boundary: kept
      message("user", 300),
      message("assistant", 400),
    ],
    streamingText: "partial",
    runningTools: new Map([["t1", "bash"]]),
    error: "boom",
    agentStartedAt: 1,
    agentEndedAt: undefined,
    thinkingStartAt: 2,
  });

  v = applyEvent(
    {
      type: "messages_truncated",
      sessionId: "s1",
      removed: [
        { role: "user", timestamp: 300 },
        { role: "assistant", timestamp: 400 },
      ],
    },
    v,
  )!;

  // Exactly the removed messages are gone — a message sharing the
  // boundary's millisecond is kept.
  assertEquals(
    v.messages.map((m) => `${m.role}:${m.timestamp}`),
    ["user:100", "assistant:100"],
  );
  // Run state is cleared (a running run was aborted).
  assertEquals(v.streamingText, "");
  assertEquals(v.runningTools.size, 0);
  assertEquals(v.error, undefined);
  assertEquals(v.agentStartedAt, undefined);
  assertEquals(v.agentEndedAt, undefined);
  assertEquals(v.thinkingStartAt, undefined);
  // The removed keys are tombstoned for the append-only resync.
  assertEquals(
    [...v.removed].sort(),
    ["user:300", "assistant:400"].sort(),
  );

  // Other sessions are ignored.
  assertEquals(
    applyEvent(
      {
        type: "messages_truncated",
        sessionId: "s2",
        removed: [{ role: "user", timestamp: 100 }],
      },
      view({ messages: [message("user", 100)] }),
    ),
    null,
  );
});

Deno.test("events: filterRemoved drops tombstoned messages from a resync", () => {
  const fetched = [
    message("user", 100),
    message("assistant", 200),
    message("user", 300),
  ];
  const removed = new Set(["user:300"]);
  const filtered = filterRemoved(fetched, removed);
  assertEquals(
    filtered.map((m) => m.timestamp),
    [100, 200],
  );
  // An empty tombstone set is a no-op (same reference).
  assertEquals(filterRemoved(fetched, new Set()), fetched);
});

Deno.test("events: session_renamed updates the session name", () => {
  let v = view();
  v = applyEvent(
    { type: "session_renamed", sessionId: "s1", name: "Fix login bug" },
    v,
  )!;
  assertEquals(v.info.name, "Fix login bug");

  // Same name: no-op (same reference).
  assertEquals(
    applyEvent({
      type: "session_renamed",
      sessionId: "s1",
      name: "Fix login bug",
    }, v),
    null,
  );

  // Other sessions are ignored.
  assertEquals(
    applyEvent({ type: "session_renamed", sessionId: "s2", name: "x" }, v),
    null,
  );
});
