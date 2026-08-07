import { assertEquals } from "@std/assert";
import { applyEvent, mergeMessages } from "./events.ts";
import type { AgentMessage, SessionView } from "./types.ts";

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
