import { assert, assertEquals } from "@std/assert";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "../ai/faux.ts";
import { createAssistantMessageEventStream } from "../ai/event-stream.ts";
import type { AgentMessage, Api, Model, StreamFn } from "../ai/types.ts";
import { ContextCompactor } from "../ai/context-compaction.ts";
import {
  STELLA_CHECKPOINT_PREAMBLE,
  STELLA_COMPACTION_STYLE,
  STELLA_RECORD_MAX_TOKENS,
  STELLA_RECORD_PROMPT,
  STELLA_RECORD_SYSTEM_PROMPT,
} from "./stella-compaction.ts";

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
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

/** An assistant turn with a tool call plus its result (one unit). */
function toolPair(id: string, text: string, timestamp: number): AgentMessage[] {
  return [
    fauxAssistantMessage([fauxToolCall("bash", { command: text }, id)], {
      timestamp,
    }),
    toolResult(id, text, timestamp + 1),
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

Deno.test("the stella record is built from the conversation, not the work", () => {
  const messages: AgentMessage[] = [
    user("hello", Date.parse("2026-01-15T12:10:00")),
    assistant("hi there", Date.parse("2026-01-15T12:11:00")),
    fauxAssistantMessage([fauxToolCall("bash", { command: "ls" }, "t1")], {
      timestamp: Date.parse("2026-01-15T12:12:00"),
    }),
    toolResult("t1", "secret output", Date.parse("2026-01-15T12:13:00")),
    {
      role: "checkpoint",
      title: "t",
      body: "old record",
      timestamp: Date.parse("2026-01-15T12:14:00"),
    } as AgentMessage,
  ];

  const parts = STELLA_COMPACTION_STYLE.serialize(messages, "old record");
  assertEquals(parts, [
    "[2026-01-15 12:10] User\nhello",
    "[2026-01-15 12:11] Assistant\nhi there",
  ]);
});

Deno.test("the stella record prompt carries the previous record as input", () => {
  const first = STELLA_COMPACTION_STYLE.prompt(undefined);
  assert(first.includes("## Now"));
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
