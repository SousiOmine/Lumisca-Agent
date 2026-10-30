import { assertEquals } from "@std/assert";
import { fauxAssistantMessage, fauxToolCall } from "../ai/faux.ts";
import type { AgentMessage } from "../ai/types.ts";
import { stellaEntryOf, stellaEventsOf } from "./stella-stream.ts";

function user(text: string, timestamp = 1): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

Deno.test("stellaEntryOf: the user's words are the user's entry", () => {
  assertEquals(stellaEntryOf(user("README を直して", 5)), {
    role: "user",
    text: "README を直して",
    cards: [],
    attachments: [],
    timestamp: 5,
  });
  // An empty prompt is nothing to show (it cannot be sent, but the
  // transcript is the database's, not the composer's).
  assertEquals(stellaEntryOf(user("", 6)), null);
});

Deno.test("stellaEntryOf: the agent's text is an assistant entry", () => {
  const message = fauxAssistantMessage("直しました。", {
    timestamp: 7,
  }) as AgentMessage;
  assertEquals(stellaEntryOf(message), {
    role: "assistant",
    text: "直しました。",
    cards: [],
    attachments: [],
    timestamp: 7,
  });
});

Deno.test("stellaEntryOf: a message that only carries a tool call is hidden", () => {
  // The work the model did (a bash call) is its history, not the
  // conversation: the entry would render as an empty row.
  const message = fauxAssistantMessage([
    fauxToolCall("bash", { command: "ls" }),
  ], { timestamp: 8 }) as AgentMessage;
  assertEquals(stellaEntryOf(message), null);
});

Deno.test("stellaEntryOf: a chat_ui card travels with the words", () => {
  const markup = '<Card title="確認"><Text>進めますか。</Text></Card>';
  const message = fauxAssistantMessage([
    { type: "text", text: "確認します。" },
    fauxToolCall("chat_ui", { markup }),
  ], { timestamp: 9 }) as AgentMessage;
  assertEquals(stellaEntryOf(message), {
    role: "assistant",
    text: "確認します。",
    cards: [markup],
    attachments: [],
    timestamp: 9,
  });

  // A reply that is only a card is still a reply.
  const onlyCard = fauxAssistantMessage([
    fauxToolCall("chat_ui", { markup }),
  ], { timestamp: 10 }) as AgentMessage;
  assertEquals(stellaEntryOf(onlyCard), {
    role: "assistant",
    text: "",
    cards: [markup],
    attachments: [],
    timestamp: 10,
  });
});

Deno.test("stellaEntryOf: the files an agent sent are an entry of their own", () => {
  const result = {
    role: "toolResult",
    toolCallId: "t2",
    toolName: "chat_attach",
    content: [{ type: "text", text: "Sent 2 files to the user." }],
    details: {
      attachments: [
        {
          name: "9f3c2a1b4d5e.png",
          displayName: "chart.png",
          size: 4096,
          inline: true,
        },
        {
          name: "0f1e2d3c4b5a.txt",
          displayName: "run.log",
          size: 12,
          inline: false,
        },
      ],
    },
    isError: false,
    timestamp: 15,
  } as AgentMessage;

  // A file the agent hands over is part of the reply, so it becomes an
  // entry — but it stays its own entry, because that is what it is in the
  // transcript (see the projection's comment on ordering).
  assertEquals(stellaEntryOf(result), {
    role: "assistant",
    text: "",
    cards: [],
    attachments: [
      {
        name: "9f3c2a1b4d5e.png",
        displayName: "chart.png",
        size: 4096,
        inline: true,
      },
      {
        name: "0f1e2d3c4b5a.txt",
        displayName: "run.log",
        size: 12,
        inline: false,
      },
    ],
    timestamp: 15,
  });

  // A failed attach sent nothing: it is the model's record of a failure, not
  // a file the user received.
  assertEquals(
    stellaEntryOf({ ...result, isError: true } as AgentMessage),
    null,
  );

  // Details an older build wrote (or a hand-edited row) show nothing rather
  // than a broken card.
  assertEquals(
    stellaEntryOf({
      ...result,
      details: { attachments: [{ name: "x.png" }] },
    } as AgentMessage),
    null,
  );
});

Deno.test("stellaEntryOf: the model's own rows are never conversation entries", () => {
  const modelOnly: AgentMessage[] = [
    {
      role: "context",
      provider: "date",
      title: "Date: 2026-10-30 (Friday)",
      body: "The current date is 2026-10-30 (Friday).",
      timestamp: 11,
    },
    {
      role: "checkpoint",
      title: "Summary",
      body: "…",
      timestamp: 12,
    },
    {
      role: "notification",
      kind: "task",
      title: "[Task agent_1 finished]",
      body: "",
      status: "success",
      timestamp: 13,
    },
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "bash",
      content: [{ type: "text", text: "total 0" }],
      details: {},
      isError: false,
      timestamp: 14,
    } as AgentMessage,
  ];
  for (const message of modelOnly) {
    assertEquals(stellaEntryOf(message), null, message.role);
  }
});

Deno.test("stellaEventsOf: the run's own events pass through", () => {
  assertEquals(
    stellaEventsOf({ type: "agent_start", sessionId: "s" }),
    [{ type: "agent_start" }],
  );
  assertEquals(
    stellaEventsOf({ type: "agent_end", sessionId: "s" }),
    [{ type: "agent_end" }],
  );
  assertEquals(
    stellaEventsOf({ type: "message_delta", sessionId: "s", delta: "あ" }),
    [{ type: "delta", delta: "あ" }],
  );
  assertEquals(
    stellaEventsOf({
      type: "session_error",
      sessionId: "s",
      message: "boom",
    }),
    [{ type: "error", message: "boom" }],
  );
});

Deno.test("stellaEventsOf: messages arrive as entries, without the session id", () => {
  const message = fauxAssistantMessage("はい。", {
    timestamp: 20,
  }) as AgentMessage;
  const events = stellaEventsOf({
    type: "message_end",
    sessionId: "s",
    message,
  });
  assertEquals(events, [{
    type: "entry",
    entry: {
      role: "assistant",
      text: "はい。",
      cards: [],
      attachments: [],
      timestamp: 20,
    },
  }]);
});

Deno.test("stellaEventsOf: the model's own events produce nothing", () => {
  // Every event the conversation has no surface for: tool progress, the
  // panels, compaction, federation.
  const modelOnly: Parameters<typeof stellaEventsOf>[0][] = [
    {
      type: "tool_start",
      sessionId: "s",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
    },
    { type: "tool_end", sessionId: "s", toolCallId: "t1", toolName: "bash" },
    { type: "todo", sessionId: "s", todos: [] },
    {
      type: "task_start",
      sessionId: "s",
      agentId: "a",
      parentAgentId: "p",
      subagentType: "general",
      description: "x",
    },
    { type: "task_delta", sessionId: "s", agentId: "a", delta: "x" },
    {
      type: "task_end",
      sessionId: "s",
      agentId: "a",
      status: "finished",
    },
    {
      type: "background_start",
      sessionId: "s",
      commandId: "c",
      pid: 1,
      command: "sleep",
      cwd: "/",
      startedAt: 1,
    },
    { type: "background_delta", sessionId: "s", commandId: "c", delta: "x" },
    {
      type: "background_end",
      sessionId: "s",
      commandId: "c",
      state: "finished",
      finishedAt: 2,
      tail: "",
    },
    {
      type: "messages_checkpoint",
      sessionId: "s",
      index: 1,
      message: {
        role: "checkpoint",
        title: "Summary",
        body: "…",
        timestamp: 3,
      },
    },
    { type: "messages_truncated", sessionId: "s", removed: [] },
    { type: "session_renamed", sessionId: "s", name: "n" },
    { type: "peer_stream", peerId: "p", connected: true },
  ];
  for (const event of modelOnly) {
    assertEquals(stellaEventsOf(event), [], event.type);
  }
});

Deno.test("stellaEventsOf: a context publication never reaches the conversation", () => {
  // The reported symptom: `Date: …` and `On-demand tools` rows in stella's
  // chat. They are context messages — the model's, not the conversation's.
  const date: AgentMessage = {
    role: "context",
    provider: "date",
    title: "Date: 2026-10-30 (Friday)",
    body: "The current date is 2026-10-30 (Friday).",
    timestamp: 30,
  };
  assertEquals(
    stellaEventsOf({ type: "message_end", sessionId: "s", message: date }),
    [],
  );
  assertEquals(
    stellaEventsOf({ type: "message_start", sessionId: "s", message: date }),
    [],
  );
});

Deno.test("stellaEventsOf: questions and the hand-over keep their shape", () => {
  const questions = [{
    id: "q1",
    question: "どれにしますか",
    options: [{ label: "A" }],
  }];
  assertEquals(
    stellaEventsOf({
      type: "question",
      sessionId: "s",
      toolCallId: "t1",
      questions,
    }),
    [{ type: "questions", questions: [{ toolCallId: "t1", questions }] }],
  );
  assertEquals(
    stellaEventsOf({
      type: "handover",
      sessionId: "s",
      toolCallId: "t2",
      reason: "ログインしてください",
      instructions: null,
    }),
    [{
      type: "handover",
      handover: {
        toolCallId: "t2",
        reason: "ログインしてください",
        instructions: null,
      },
    }],
  );
  assertEquals(
    stellaEventsOf({
      type: "handover_end",
      sessionId: "s",
      toolCallId: "t2",
      note: "done",
    }),
    [{ type: "handover", handover: null }],
  );
});
