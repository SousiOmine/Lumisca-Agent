import { assert, assertEquals } from "@std/assert";
import { fauxAssistantMessage, fauxToolCall } from "../ai/faux.ts";
import type { AgentMessage } from "../ai/types.ts";
import { NO_RESPONSE } from "./silent-reply.ts";
import {
  stellaEntryCursorOf,
  stellaEntryOf,
  stellaEventsOf,
} from "./stella-stream.ts";

function user(text: string, timestamp = 1): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

/** A `send_chat` result carrying the given `details` (the tool's own
 * shape; see tools/send-chat.ts). */
function sent(details: Record<string, unknown>, timestamp = 10): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "send_chat",
    content: [{ type: "text", text: "Sent the message to the user." }],
    details,
    isError: false,
    timestamp,
  } as AgentMessage;
}

Deno.test("stellaEntryOf: the user's words are the user's entry", () => {
  assertEquals(stellaEntryOf(user("README を直して", 5)), {
    role: "user",
    text: "README を直して",
    segments: [{ type: "text", text: "README を直して" }],
    attachments: [],
    files: [],
    timestamp: 5,
  });
  // An empty prompt is nothing to show (it cannot be sent, but the
  // transcript is the database's, not the composer's).
  assertEquals(stellaEntryOf(user("", 6)), null);
});

Deno.test("stellaEntryOf: the agent's text is the conversation's message", () => {
  // The default is to speak. A run that has nothing to say writes the
  // sentinel (silent-reply.ts) — silence is the deliberate act, so a forgotten
  // decision produces a message rather than an unanswered question.
  const prose = fauxAssistantMessage("直しました。", {
    timestamp: 7,
  }) as AgentMessage;
  const entry = stellaEntryOf(prose);
  assertEquals(entry?.role, "assistant");
  assertEquals(entry?.text, "直しました。");
  assertEquals(entry?.timestamp, 7);
});

Deno.test("stellaEntryOf: the sentinel is how a run stays silent", () => {
  const silent = fauxAssistantMessage(NO_RESPONSE, {
    timestamp: 7,
  }) as AgentMessage;
  assertEquals(stellaEntryOf(silent), null);
  // Repeated (a model re-emitting it per tool batch) is still silence.
  const repeated = fauxAssistantMessage(`${NO_RESPONSE}${NO_RESPONSE}`, {
    timestamp: 8,
  }) as AgentMessage;
  assertEquals(stellaEntryOf(repeated), null);
  // A sentinel with prose around it is an ANSWER, not silence: dropping it
  // would lose what the agent actually said.
  const mixed = fauxAssistantMessage(`${NO_RESPONSE} 直しました。`, {
    timestamp: 9,
  }) as AgentMessage;
  const entry = stellaEntryOf(mixed);
  assertEquals(entry?.text, "直しました。");
});

Deno.test("stellaEntryOf: narration before a tool is not a message", () => {
  // A message that ends in a tool call is the model thinking out loud with a
  // tool attached. A run that runs ten tools writes ten of these, and showing
  // them buries the answer under its own working notes.
  const narration = fauxAssistantMessage("ファイルを確認します。", {
    stopReason: "toolUse",
    timestamp: 7,
  }) as AgentMessage;
  assertEquals(stellaEntryOf(narration), null);
  // With a tool call in the same message it is still narration, not an answer.
  const withCall = fauxAssistantMessage(
    [
      { type: "text", text: "テストを実行します。" },
      fauxToolCall("bash", { command: "deno task test" }),
    ],
    { stopReason: "toolUse", timestamp: 8 },
  ) as AgentMessage;
  assertEquals(stellaEntryOf(withCall), null);
});

Deno.test("stellaEntryOf: the final text of a run is the message", () => {
  // What the model says when it STOPS (no tool call) is its answer.
  const final = fauxAssistantMessage("直しました。テストも通っています。", {
    stopReason: "stop",
    timestamp: 9,
  }) as AgentMessage;
  const entry = stellaEntryOf(final);
  assertEquals(entry?.role, "assistant");
  assertEquals(entry?.text, "直しました。テストも通っています。");
});

Deno.test("stellaEntryOf: a turn that only ran a tool says nothing", () => {
  // No text at all: the agent has not spoken yet, and a tool call is the
  // model's record of its work, not a message.
  const toolOnly = fauxAssistantMessage(
    [fauxToolCall("bash", { command: "ls" })],
    { timestamp: 8 },
  ) as AgentMessage;
  assertEquals(stellaEntryOf(toolOnly), null);
});

Deno.test("stellaEntryOf: what send_chat sent is the conversation's message", () => {
  assertEquals(stellaEntryOf(sent({ text: "確認します。", attachments: [] })), {
    role: "assistant",
    text: "確認します。",
    segments: [{ type: "text", text: "確認します。" }],
    attachments: [],
    files: [],
    timestamp: 10,
  });

  // A card written into the text is a block of the message: the words around
  // it and the card keep the order the agent wrote them in.
  const card = '<Card title="確認"><Text>進めますか。</Text></Card>';
  assertEquals(
    stellaEntryOf(
      sent({
        text: `確認します。\n\n\`\`\`card\n${card}\n\`\`\`\n\n進めますか。`,
        attachments: [],
      }),
    ),
    {
      role: "assistant",
      text: "確認します。\n\n進めますか。",
      segments: [
        { type: "text", text: "確認します。" },
        { type: "card", markup: card },
        { type: "text", text: "進めますか。" },
      ],
      attachments: [],
      files: [],
      timestamp: 10,
    },
  );

  // A message that is only a card is still a message.
  assertEquals(
    stellaEntryOf(
      sent(
        {
          text: `\`\`\`card\n${card}\n\`\`\``,
          attachments: [],
        },
        11,
      ),
    ),
    {
      role: "assistant",
      text: "",
      segments: [{ type: "card", markup: card }],
      attachments: [],
      files: [],
      timestamp: 11,
    },
  );
});

Deno.test("stellaEntryOf: the files an agent sent travel with its message", () => {
  const attachments = [
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
  ];
  assertEquals(
    stellaEntryOf(sent({ text: "2枚送ります。", attachments }, 15)),
    {
      role: "assistant",
      text: "2枚送ります。",
      segments: [{ type: "text", text: "2枚送ります。" }],
      attachments,
      files: [],
      timestamp: 15,
    },
  );

  // The files alone are a message too (a picture needs no caption).
  assertEquals(stellaEntryOf(sent({ text: "", attachments }, 16)), {
    role: "assistant",
    text: "",
    segments: [],
    attachments,
    files: [],
    timestamp: 16,
  });
});

Deno.test("stellaEntryOf: a failed or empty send_chat shows nothing", () => {
  const details = {
    text: "送れませんでした",
    attachments: [
      {
        name: "9f3c2a1b4d5e.png",
        displayName: "chart.png",
        size: 4096,
        inline: true,
      },
    ],
  };
  // A failed call sent nothing: it is the model's record of a failure, not
  // something the user received.
  assertEquals(
    stellaEntryOf({ ...sent(details), isError: true } as AgentMessage),
    null,
  );
  // Details this build did not write (a hand-edited row, another tool's
  // shape) draw nothing rather than an empty bubble.
  assertEquals(stellaEntryOf(sent({ attachments: [{ name: "x.png" }] })), null);
  assertEquals(stellaEntryOf(sent({ text: "", attachments: [] })), null);
  assertEquals(stellaEntryOf(sent({ text: null })), null);
});

Deno.test("stellaEntryOf: the tools send_chat replaced show nothing", () => {
  // A conversation that predates send_chat keeps only its user's side: the
  // old rows are the record of a rule that no longer exists.
  const old: AgentMessage[] = [
    {
      role: "toolResult",
      toolCallId: "t2",
      toolName: "chat_attach",
      content: [{ type: "text", text: "Sent 1 file to the user." }],
      details: {
        attachments: [
          {
            name: "9f3c2a1b4d5e.png",
            displayName: "chart.png",
            size: 4096,
            inline: true,
          },
        ],
      },
      isError: false,
      timestamp: 20,
    } as AgentMessage,
  ];
  // The old TOOL results stay out of the conversation: they are the record of
  // a rule that no longer exists.
  for (const message of old) {
    assertEquals(stellaEntryOf(message), null, message.role);
  }
});

Deno.test("stellaEntryOf: an old chat_ui call shows its words, not its card", () => {
  // The assistant message that made the old call wrote a sentence first. That
  // sentence is a message under the current rule (the agent's text is the
  // conversation's), while the card it attached is not: a card only arrives
  // through send_chat now.
  const old = fauxAssistantMessage(
    [
      { type: "text", text: "確認します。" },
      fauxToolCall("chat_ui", {
        markup: '<Card title="確認"><Text>進めますか。</Text></Card>',
      }),
    ],
    { timestamp: 21 },
  ) as AgentMessage;
  const entry = stellaEntryOf(old);
  assertEquals(entry?.text, "確認します。");
  assertEquals(entry?.segments, [{ type: "text", text: "確認します。" }]);
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
  assertEquals(stellaEventsOf({ type: "agent_start", sessionId: "s" }), [
    { type: "agent_start" },
  ]);
  assertEquals(stellaEventsOf({ type: "agent_end", sessionId: "s" }), [
    { type: "agent_end" },
  ]);
  // The agent's text is not the conversation's, so a delta has nothing to
  // add to it (see the projection's comment).
  assertEquals(
    stellaEventsOf({ type: "message_delta", sessionId: "s", delta: "あ" }),
    [],
  );
});

Deno.test("stellaEventsOf: a message becomes an entry, twice over", () => {
  // Both events carry the same message (a synthetic start/end pair for an
  // injected prompt): sending the entry twice is harmless, and a client that
  // missed the start still gets the message.
  const message = user("hello", 5);
  const expected = [{ type: "entry" as const, entry: stellaEntryOf(message)! }];
  assertEquals(
    stellaEventsOf({ type: "message_start", sessionId: "s", message }),
    expected,
  );
  assertEquals(
    stellaEventsOf({ type: "message_end", sessionId: "s", message }),
    expected,
  );
});

Deno.test("stellaEventsOf: the model's tool traffic stays out of the stream", () => {
  const toolStart = stellaEventsOf({
    type: "tool_start",
    sessionId: "s",
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "ls" },
  });
  assertEquals(toolStart, []);
  const toolEnd = stellaEventsOf({
    type: "tool_end",
    sessionId: "s",
    toolCallId: "t1",
    toolName: "bash",
  });
  assertEquals(toolEnd, []);
});

Deno.test("stellaEventsOf: a failure reaches the conversation", () => {
  assertEquals(
    stellaEventsOf({
      type: "session_error",
      sessionId: "s",
      message: "provider not configured",
    }),
    [{ type: "error", message: "provider not configured" }],
  );
});

Deno.test("stellaEventsOf: an ask and a hand-over are the run's own state", () => {
  assertEquals(
    stellaEventsOf({
      type: "question",
      sessionId: "s",
      toolCallId: "ask_1",
      questions: [
        {
          id: "q1",
          question: "どれにしますか。",
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
    }),
    [
      {
        type: "questions",
        questions: [
          {
            toolCallId: "ask_1",
            questions: [
              {
                id: "q1",
                question: "どれにしますか。",
                options: [{ label: "A" }, { label: "B" }],
              },
            ],
          },
        ],
      },
    ],
  );
  assertEquals(
    stellaEventsOf({
      type: "handover",
      sessionId: "s",
      toolCallId: "vm_1",
      reason: "password",
      instructions: null,
      expiresAt: 1_700_000_000_000,
    }),
    [
      {
        type: "handover",
        handover: {
          toolCallId: "vm_1",
          reason: "password",
          instructions: null,
          // The deadline is part of the request: a conversation that
          // reconnects mid-wait draws it from the snapshot.
          expiresAt: 1_700_000_000_000,
        },
      },
    ],
  );
  assertEquals(
    stellaEventsOf({
      type: "handover_end",
      sessionId: "s",
      toolCallId: "vm_1",
      note: "",
    }),
    [{ type: "handover", handover: null }],
  );
});

Deno.test("stellaEntryOf: a prompt's files are its own content", () => {
  // The user dropped a screenshot in and asked nothing. Dropping the entry
  // would show an agent reply with no question above it, so the file it
  // brought in keeps the turn.
  const message: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "" }],
    files: [
      {
        name: "image-1.png",
        path: "/home/agent/agents/a1/uploads/1-ab/01-image-1.png",
        size: 5,
        ref: "uploads/1-ab/01-image-1.png",
        image: true,
      },
    ],
    timestamp: 30,
  };
  assertEquals(stellaEntryOf(message)?.files[0]?.name, "image-1.png");

  // A message that says nothing and brings nothing is not a message.
  assertEquals(
    stellaEntryOf({ role: "user", content: [], timestamp: 32 }),
    null,
  );

  // A prompt with words keeps them, and the pictures it brought in are the
  // files the message carries.
  const both: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "これを見て" }],
    files: [
      {
        name: "image-1.png",
        path: "/home/agent/agents/a1/uploads/1-ab/01-image-1.png",
        size: 5,
        ref: "uploads/1-ab/01-image-1.png",
        image: true,
      },
    ],
    timestamp: 31,
  };
  const entry = stellaEntryOf(both);
  assertEquals(entry?.text, "これを見て");
  assertEquals(entry?.files[0]?.ref, "uploads/1-ab/01-image-1.png");
});

Deno.test("stellaEntryOf: a prompt with only model instruction stays hidden", () => {
  // UserMessage.modelContent lets a prompt carry text for the model that the
  // user never sees. When that is ALL the prompt is, the conversation draws
  // nothing — the decision this pins: a message with no visible text and no
  // file has nothing to draw, and the run it started still happens. The
  // model's copy must not leak into the transcript instead.
  const message: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "" }],
    modelContent: "[Attached files]\n- notes.txt: /vm/notes.txt",
    timestamp: 9,
  };
  assertEquals(stellaEntryOf(message), null);
});

Deno.test("stellaEntryOf: a prompt that is only files IS shown", () => {
  // The other half of the rule above: files are something to draw, so the
  // prompt is a real entry even with no words.
  const message: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "" }],
    modelContent: "[Attached files]\n- notes.txt: /vm/notes.txt",
    files: [
      {
        name: "notes.txt",
        path: "/vm/notes.txt",
        size: 5,
        ref: "uploads/1-ab/01-notes.txt",
        image: false,
      },
    ],
    timestamp: 10,
  };
  const entry = stellaEntryOf(message);
  assertEquals(entry?.text, "");
  assertEquals(
    entry?.files.map((file) => file.name),
    ["notes.txt"],
  );
});

Deno.test("stellaEntryOf: a routine's prompt keeps the routine's name", () => {
  // The prompt sits on the user's side (the run is delivered like a typed
  // message), but the user did not write it: the projection must carry the
  // name so a client can say who asked (#37).
  const prompt: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "毎朝デプロイを確認して" }],
    routine: "朝のデプロイ確認",
    timestamp: 9,
  };
  assertEquals(stellaEntryOf(prompt), {
    role: "user",
    text: "毎朝デプロイを確認して",
    segments: [{ type: "text", text: "毎朝デプロイを確認して" }],
    attachments: [],
    files: [],
    routine: "朝のデプロイ確認",
    timestamp: 9,
  });
  // A typed prompt carries none, so the client draws no label.
  assertEquals(stellaEntryOf(user("自分で打った", 10))?.routine, undefined);
  // Nor does a mode prompt (stella has none, but the projection is written
  // against the transcript's type).
  assertEquals(
    stellaEntryOf({
      role: "mode",
      modeId: "review",
      shortText: "レビュー",
      images: [],
      optionId: "o1",
      modeLabel: "Review",
      fullPrompt: "review it",
      timestamp: 11,
    } as AgentMessage)?.routine,
    undefined,
  );
});

Deno.test("stellaEntryCursor: a routine's prompt and the same words differ", () => {
  const typed: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "確認して" }],
    timestamp: 12,
  };
  const scheduled = { ...typed, routine: "毎朝" } as AgentMessage;
  assert(
    stellaEntryCursorOf(stellaEntryOf(typed)!) !==
      stellaEntryCursorOf(stellaEntryOf(scheduled)!),
    "the routine's name is part of the entry's identity",
  );
});
