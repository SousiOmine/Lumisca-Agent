import { assert, assertEquals } from "@std/assert";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "../ai/faux.ts";
import { createAssistantMessageEventStream } from "../ai/event-stream.ts";
import type {
  AgentMessage,
  Api,
  Model,
  StreamFn,
  ToolResultMessage,
} from "../ai/types.ts";
import { ContextCompactor } from "../ai/context-compaction.ts";
import {
  STELLA_CHECKPOINT_PREAMBLE,
  STELLA_COMPACTION_STYLE,
  STELLA_RECORD_MAX_TOKENS,
  STELLA_RECORD_PROMPT,
  STELLA_RECORD_SYSTEM_PROMPT,
} from "./stella-compaction.ts";

/** A local wall-clock minute on one fixed day, so the expected strings do not
 * depend on the test machine's time zone (see formatLocalDateTime). */
function at(minute: number): number {
  return Date.parse(
    `2026-01-15T12:${String(minute).padStart(2, "0")}:00`,
  );
}

function user(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(text: string, timestamp: number): AgentMessage {
  return fauxAssistantMessage([fauxText(text)], { timestamp });
}

function toolResult(
  id: string,
  text: string,
  timestamp: number,
  options: { name?: string; isError?: boolean } = {},
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: options.name ?? "bash",
    content: [{ type: "text", text }],
    isError: options.isError === true,
    timestamp,
  };
}

/** An assistant turn with a tool call plus its result (one unit). */
function toolPair(
  id: string,
  text: string,
  timestamp: number,
  options: { name?: string; isError?: boolean } = {},
): AgentMessage[] {
  return [
    fauxAssistantMessage(
      [fauxToolCall(options.name ?? "bash", { command: text }, id)],
      { timestamp },
    ),
    toolResult(id, text, timestamp + 1, options),
  ];
}

interface RecordedRequest {
  systemPrompt?: string;
  messages: readonly unknown[];
  maxOutputTokens?: number;
}

function requestText(request: RecordedRequest): string {
  const message = request.messages[0] as {
    content: Array<{ text: string }>;
  };
  return message.content[0]!.text;
}

Deno.test("the record puts a tools line between the messages around it", () => {
  const messages: AgentMessage[] = [
    user("hello", at(10)),
    ...toolPair("t1", "secret output", at(11)),
    assistant("done", at(12)),
  ];

  assertEquals(STELLA_COMPACTION_STYLE.serialize(messages, undefined), [
    "[2026-01-15 12:10] User\nhello",
    "[tools] bash ×1",
    "[2026-01-15 12:12] Assistant\ndone",
  ]);
});

Deno.test("a call's arguments and a result's output never reach the record", () => {
  const messages: AgentMessage[] = [
    user("hello", at(10)),
    ...toolPair("t1", "secret output", at(11)),
    assistant("done", at(12)),
  ];
  const text = STELLA_COMPACTION_STYLE.serialize(messages, undefined)
    .join("\n");
  // The same string is the call's argument and the result's body: neither
  // may leak into the record's input.
  assert(!text.includes("secret output"));
});

Deno.test("each run of tool calls gets its own line where it happened", () => {
  const messages: AgentMessage[] = [
    user("go", at(10)),
    assistant("looking", at(11)),
    ...toolPair("t1", "x", at(12)),
    ...toolPair("t2", "y", at(14)),
    assistant("found it", at(16)),
    ...toolPair("t3", "z", at(17)),
    assistant("done", at(19)),
  ];

  assertEquals(STELLA_COMPACTION_STYLE.serialize(messages, undefined), [
    "[2026-01-15 12:10] User\ngo",
    "[2026-01-15 12:11] Assistant\nlooking",
    "[tools] bash ×2",
    "[2026-01-15 12:16] Assistant\nfound it",
    "[tools] bash ×1",
    "[2026-01-15 12:19] Assistant\ndone",
  ]);
});

Deno.test("a run that ends the span still gets its line", () => {
  // The span was cut while the work was in flight (no message after it):
  // dropping the line would hide that the work happened at all.
  const messages: AgentMessage[] = [
    user("go", at(10)),
    ...toolPair("t1", "x", at(11)),
  ];
  assertEquals(STELLA_COMPACTION_STYLE.serialize(messages, undefined), [
    "[2026-01-15 12:10] User\ngo",
    "[tools] bash ×1",
  ]);
});

Deno.test("send_chat is the conversation, not a tool to tally", () => {
  const messages: AgentMessage[] = [
    user("hi", at(10)),
    fauxAssistantMessage([fauxToolCall("send_chat", { text: "hello" }, "s1")], {
      timestamp: at(11),
    }),
    {
      role: "toolResult",
      toolCallId: "s1",
      toolName: "send_chat",
      content: [{ type: "text", text: "sent" }],
      isError: false,
      details: { text: "hello", card: null },
      timestamp: at(12),
    },
    assistant("done", at(13)),
  ];

  assertEquals(STELLA_COMPACTION_STYLE.serialize(messages, undefined), [
    "[2026-01-15 12:10] User\nhi",
    "[2026-01-15 12:12] Assistant\nhello",
    "[2026-01-15 12:13] Assistant\ndone",
  ]);
});

Deno.test("a failed call is counted as a call and marked as failed", () => {
  const messages: AgentMessage[] = [
    user("go", at(10)),
    fauxAssistantMessage([
      fauxToolCall("bash", { command: "ok" }, "t1"),
      fauxToolCall("bash", { command: "boom" }, "t2"),
    ], { timestamp: at(11) }),
    toolResult("t1", "ok", at(12)),
    toolResult("t2", "boom", at(13), { isError: true }),
    assistant("done", at(14)),
  ];
  assertEquals(STELLA_COMPACTION_STYLE.serialize(messages, undefined), [
    "[2026-01-15 12:10] User\ngo",
    "[tools] bash ×2 (1 failed)",
    "[2026-01-15 12:14] Assistant\ndone",
  ]);
});

Deno.test("the tools line names at most 12 tools", () => {
  const messages: AgentMessage[] = [user("go", at(10))];
  for (let i = 0; i < 13; i++) {
    messages.push(
      fauxAssistantMessage([fauxToolCall(`tool_${i}`, {}, `c${i}`)], {
        timestamp: at(11),
      }),
    );
  }
  messages.push(assistant("done", at(12)));

  const parts = STELLA_COMPACTION_STYLE.serialize(messages, undefined);
  const line = parts.find((part) => part.startsWith("[tools] "))!;
  assertEquals((line.match(/×/g) ?? []).length, 12);
  assert(line.endsWith(", +1 more"));
});

Deno.test("a conversation with no tool calls has no tools line", () => {
  const messages: AgentMessage[] = [
    user("hi", at(10)),
    assistant("hello", at(11)),
  ];
  assertEquals(STELLA_COMPACTION_STYLE.serialize(messages, undefined), [
    "[2026-01-15 12:10] User\nhi",
    "[2026-01-15 12:11] Assistant\nhello",
  ]);
});

Deno.test("the stella record prompt explains the tools line and its limits", () => {
  const first = STELLA_COMPACTION_STYLE.prompt(undefined);
  assert(first.includes("## Now"));
  assert(first.includes("[tools]"));
  assert(first.includes("never write its counts"));
  assert(!first.startsWith("<previous-record>"));

  const next = STELLA_COMPACTION_STYLE.prompt("## Now\n- old");
  assert(
    next.startsWith("<previous-record>\n## Now\n- old\n</previous-record>\n\n"),
  );
  assert(next.includes("rewrite it in full"));
});

Deno.test("a stella compaction sends the record prompt and the stella preamble", async () => {
  const messages: AgentMessage[] = [
    user(`start ${"x".repeat(10_000)}`, 1),
    assistant(`earlier reply ${"y".repeat(10_000)}`, 2),
    ...toolPair("t1", `secret output ${"z".repeat(20_000)}`, 3),
    assistant(`final ${"w".repeat(10_000)}`, 5),
  ];
  const requests: RecordedRequest[] = [];
  const streamFn: StreamFn = (_model, context, options) => {
    requests.push({
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      maxOutputTokens: options?.maxOutputTokens,
    });
    const reply = "## Now\n- condensed";
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: fauxAssistantMessage(reply) });
    stream.push({ type: "text_delta", delta: reply });
    stream.end(fauxAssistantMessage(reply));
    return stream;
  };
  const inserts: AgentMessage[] = [];
  const compactor = new ContextCompactor({
    model: {
      id: "small",
      name: "small",
      api: "openai-completions",
      provider: "p",
      contextWindow: 200_000,
      maxTokens: 64_000,
    } as Model<Api>,
    systemPrompt: () => "You are Lumisca.",
    tools: () => [],
    streamFn,
    sessionId: "s1",
    style: STELLA_COMPACTION_STYLE,
    policy: () => ({ reservePercent: 20, keepRecentPercent: 1 }),
    insert: (index, message) => {
      inserts.push(message);
      messages.splice(index, 0, message);
    },
  });

  const result = await compactor.compactNow(messages);
  assert(result !== null);
  assertEquals(requests.length, 1);
  assertEquals(requests[0]!.systemPrompt, STELLA_RECORD_SYSTEM_PROMPT);
  assertEquals(requests[0]!.maxOutputTokens, STELLA_RECORD_MAX_TOKENS);

  const text = requestText(requests[0]!);
  assert(text.includes(STELLA_RECORD_PROMPT));
  assert(text.includes("earlier reply"));
  assert(text.includes("[tools] bash ×1"));
  // The tool output is the work, not the conversation: it never reaches the
  // record's input, even though the head contains it.
  assert(!text.includes("secret output"));

  assertEquals(inserts.length, 1);
  assert(
    (inserts[0] as { body: string }).body.startsWith(
      STELLA_CHECKPOINT_PREAMBLE,
    ),
  );
});

Deno.test("a routine's run is recorded as the routine's, not the user's", () => {
  // The record is what a future turn believes about the user. Reading the
  // scheduled request as their words would credit them with a request they
  // scheduled days ago (#37).
  const messages: AgentMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "check the deploy" }],
      routine: "Morning deploy check",
      timestamp: at(10),
    },
    assistant("all green", at(12)),
  ];
  assertEquals(STELLA_COMPACTION_STYLE.serialize(messages, undefined), [
    '[2026-01-15 12:10] User (routine "Morning deploy check")\ncheck the deploy',
    "[2026-01-15 12:12] Assistant\nall green",
  ]);
  // The prompt itself says what such a line means.
  assert(STELLA_RECORD_PROMPT.includes('User (routine "…")'));
});
