/**
 * Prefix stability: the property the provider's prompt cache depends on.
 *
 * The provider serves a request from its cache only up to the first token
 * that differs from the previous request, so every request the loop sends
 * must be an append-extension of its predecessor — same system prompt, same
 * tool schemas, and a message list that starts with exactly the previous
 * one. These tests drive the real loop with a recording transport and
 * assert that property (the keyless half of the observation; the key-gated
 * half that proves a real provider serves the prefix lives in
 * prefix-cache.e2e_test.ts).
 *
 * The two events that genuinely cost the cached prefix — a changed head and
 * a rewritten history — are reported by the loop as a RequestShape with its
 * reason, so a cache-read drop can be explained afterwards.
 */
import { assert, assertEquals } from "@std/assert";
import { Agent } from "./agent.ts";
import { createAssistantMessageEventStream } from "./event-stream.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "./faux.ts";
import { toLlmMessages } from "../types/notification.ts";
import type {
  AgentMessage,
  AgentTool,
  Api,
  AssistantMessage,
  Model,
  RequestShape,
  StreamFn,
  StreamRequest,
} from "./types.ts";

function fakeModel(): Model<Api> {
  return { id: "m", name: "m" } as unknown as Model<Api>;
}

/** One request exactly as the transport receives it. */
interface RecordedRequest {
  systemPrompt: string | undefined;
  toolNames: string[];
  messages: unknown[];
}

/** The tool the scripted turns call; its result is what makes the next
 * request longer than the previous one. */
function echoTool(): AgentTool {
  return {
    name: "echo",
    label: "Echo",
    description: "Echo the given value back.",
    parameters: { type: "object", properties: { value: { type: "string" } } },
    execute: (_id, params) =>
      Promise.resolve({
        content: [{
          type: "text",
          text: `value = ${(params as { value: string }).value}`,
        }],
        details: {},
      }),
  } as AgentTool;
}

/**
 * An agent over a recording transport: `script[call]` produces the assistant
 * message of one LLM call (the last entry repeats when the script is
 * shorter). Tool calls are executed by the loop's fallback path — the
 * recording transport never emits `toolcall_result`, which is exactly what a
 * test double looks like to the loop.
 */
function makeAgent(options: {
  script: Array<(call: number) => AssistantMessage>;
  tools?: AgentTool[];
  onRequest?: (shape: RequestShape) => void;
  systemPrompt?: string;
}): { agent: Agent; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  let call = 0;
  const streamFn: StreamFn = (_model, context: StreamRequest) => {
    requests.push({
      systemPrompt: context.systemPrompt,
      toolNames: (context.tools ?? []).map((tool) => tool.name),
      messages: context.messages as unknown[],
    });
    const index = Math.min(call, options.script.length - 1);
    call++;
    const message = options.script[index]!(index);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.end(message);
    return stream;
  };
  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt ?? "You are a test agent.",
      model: fakeModel(),
      tools: options.tools ?? [],
      messages: [],
    },
    streamFn,
    sessionId: "s1",
    convertToLlm: (messages) => toLlmMessages(messages),
    ...(options.onRequest !== undefined
      ? { onRequest: options.onRequest }
      : {}),
  });
  return { agent, requests };
}

/** Assert that `current` extends `previous` without changing a single byte
 * the provider already saw. */
function assertPrefixExtension(previous: unknown[], current: unknown[]): void {
  assert(
    current.length >= previous.length,
    `the request shrank: ${previous.length} → ${current.length} messages`,
  );
  assertEquals(
    current.slice(0, previous.length),
    previous,
    "the shared prefix of the two requests changed",
  );
}

/** A tool-call turn, then a final text turn, then the next prompt's turn. */
function toolScript(): Array<(call: number) => AssistantMessage> {
  return [
    () =>
      fauxAssistantMessage([
        fauxText("Looking it up."),
        fauxToolCall("echo", { value: "alpha" }, "call_1"),
      ], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("The value is alpha."),
    () => fauxAssistantMessage("Second turn."),
  ];
}

Deno.test("prefix: each step of a tool-using turn extends the previous request", async () => {
  const { agent, requests } = makeAgent({
    script: toolScript(),
    tools: [echoTool()],
  });

  await agent.prompt("Look up alpha.");
  await agent.prompt("Thanks.");

  // Turn 1 has two steps (the tool call and the answer), turn 2 one.
  assertEquals(requests.length, 3);
  for (const request of requests) {
    assertEquals(request.systemPrompt, requests[0]!.systemPrompt);
    assertEquals(request.toolNames, requests[0]!.toolNames);
  }
  assertPrefixExtension(requests[0]!.messages, requests[1]!.messages);
  assertPrefixExtension(requests[1]!.messages, requests[2]!.messages);
  // The tool result really is what made the second request longer.
  assert(
    requests[1]!.messages.length === requests[0]!.messages.length + 2,
    "the tool-call turn must add the assistant message and its result",
  );
});

Deno.test("prefix: a context message published between runs extends the prefix", async () => {
  const { agent, requests } = makeAgent({
    script: [
      () => fauxAssistantMessage("First."),
      () => fauxAssistantMessage("Second."),
    ],
  });

  await agent.prompt("One.");
  // A provider publishes before the next run (see agent/context-providers):
  // the snapshot is appended, never inserted, so the earlier prefix holds.
  agent.appendMessage({
    role: "context",
    provider: "date",
    title: "Date: 2026-10-08 (Thursday)",
    body: "The current date is 2026-10-08 (Thursday).",
    timestamp: Date.now(),
  });
  await agent.prompt("Two.");

  assertEquals(requests.length, 2);
  assertEquals(requests[0]!.systemPrompt, requests[1]!.systemPrompt);
  assertPrefixExtension(requests[0]!.messages, requests[1]!.messages);
  assertEquals(
    requests[1]!.messages.length,
    requests[0]!.messages.length + 3,
    "the previous reply, the context snapshot and the new prompt are appended",
  );
});

Deno.test("prefix: the loop reports the shape and the two changes that cost the cache", async () => {
  const shapes: RequestShape[] = [];
  const { agent, requests } = makeAgent({
    script: toolScript(),
    tools: [echoTool()],
    onRequest: (shape) => shapes.push(shape),
  });

  await agent.prompt("Look up alpha.");
  await agent.prompt("Thanks.");

  // One shape per request, in order; the first is the session's first.
  assertEquals(shapes.length, requests.length);
  assertEquals(shapes[0]!.change, "initial");
  assertEquals(shapes[0]!.messageCount, requests[0]!.messages.length);
  for (const shape of shapes.slice(1)) {
    assertEquals(
      shape.change,
      undefined,
      "an append-extension is not a cache break",
    );
  }
  assert(
    shapes.every((shape) => shape.headHash === shapes[0]!.headHash),
    "the head hash must stay stable across steps",
  );

  // A changed head (the system prompt, the tool schemas) invalidates
  // everything: the request is reported as head-changed.
  agent.state.systemPrompt += "\nExtra rule.";
  await agent.prompt("Three.");
  assertEquals(shapes.at(-1)!.change, "head-changed");
  assert(
    shapes.at(-1)!.headHash !== shapes[0]!.headHash,
    "a changed head must produce a different hash",
  );

  // A rewritten history (a compaction, a rewind) keeps the head but loses
  // the message prefix: reported as history-rewritten.
  agent.state.messages.splice(1, 1);
  await agent.prompt("Four.");
  assertEquals(shapes.at(-1)!.change, "history-rewritten");
  assertEquals(
    shapes.at(-1)!.headHash,
    shapes.at(-2)!.headHash,
    "the head did not change — only the history did",
  );
});

Deno.test("repeat guard: an identical call repeated three times earns one reminder", async () => {
  const call = (n: number) => () =>
    fauxAssistantMessage([
      fauxText(`Try ${n}.`),
      fauxToolCall("echo", { value: "same" }, `call_${n}`),
    ], { stopReason: "toolUse" });
  const { agent } = makeAgent({
    script: [call(1), call(2), call(3), () => fauxAssistantMessage("Done.")],
    tools: [echoTool()],
  });

  await agent.prompt("Keep trying.");

  const notices = agent.state.messages.filter(
    (message): message is Extract<AgentMessage, { role: "notification" }> =>
      message.role === "notification" && message.kind === "notice",
  );
  assertEquals(notices.length, 1, "exactly one reminder for the third repeat");
  const notice = notices[0]!;
  assertEquals(notice.title, "[Repeated tool call: echo]");
  assertEquals(notice.status, "neutral");
  assertEquals(notice.steered, true, "the reminder joins the running turn");
  assert(
    notice.body.includes("3 times in a row with identical arguments"),
    `unexpected reminder body: ${notice.body}`,
  );

  // It lands after the repeated call's result and before the next request:
  // the model reads the result first, then the advice.
  const index = agent.state.messages.indexOf(notice);
  assertEquals(agent.state.messages[index - 1]!.role, "toolResult");
  assertEquals(agent.state.messages[index + 1]!.role, "assistant");
});

Deno.test("repeat guard: a different call and a new prompt both reset the count", async () => {
  const repeated = (n: number) => () =>
    fauxAssistantMessage([
      fauxToolCall("echo", { value: "same" }, `call_${n}`),
    ], { stopReason: "toolUse" });
  const other = () =>
    fauxAssistantMessage([
      fauxToolCall("echo", { value: "different" }, "call_other"),
    ], { stopReason: "toolUse" });
  const { agent } = makeAgent({
    script: [
      repeated(1),
      repeated(2),
      other,
      repeated(3),
      repeated(4),
      () => fauxAssistantMessage("Done."),
    ],
    tools: [echoTool()],
  });

  await agent.prompt("Work.");
  assertEquals(
    agent.state.messages.filter((m) => m.role === "notification").length,
    0,
    "two repeats, then a different call: never three in a row",
  );

  // A new prompt clears the count too: the same call after it is the first
  // of a new instruction, not a loop.
  await agent.prompt("Again.");
  assertEquals(
    agent.state.messages.filter((m) => m.role === "notification").length,
    0,
    "a new prompt must reset the repeat counter",
  );
});
