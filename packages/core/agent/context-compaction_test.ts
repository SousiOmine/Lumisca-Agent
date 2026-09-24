import { assertEquals } from "@std/assert";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "../ai/faux.ts";
import type {
  AgentMessage,
  AgentTool,
  Api,
  Model,
  StreamFn,
} from "../ai/types.ts";
import { createAssistantMessageEventStream } from "../ai/event-stream.ts";
import {
  CHECKPOINT_PREAMBLE,
  CHECKPOINT_SUMMARY_TAG,
  checkpointSummaryText,
  ContextCompactor,
  contextStart,
  DEFAULT_COMPACTION_POLICY,
  resolveCompactionBudgets,
  resolveCompactionPolicy,
  selectCompactionSpan,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  transcriptUnits,
  UPDATE_SUMMARIZATION_PROMPT,
} from "./context-compaction.ts";

/** A model with a wide window: the summarization request then has room for
 * the whole head, so a test can assert on the request as it was built. */
function wideModel(): Model<Api> {
  return {
    id: "test-model",
    name: "Test",
    api: "openai-completions",
    provider: "test",
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

function modelWith(contextWindow: number, maxTokens: number): Model<Api> {
  return {
    id: "small",
    name: "small",
    api: "openai-completions",
    provider: "p",
    contextWindow,
    maxTokens,
  };
}

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistant(text: string): AgentMessage {
  return fauxAssistantMessage([fauxText(text)]);
}

function toolResult(id: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 2,
  };
}

/** An assistant turn with a tool call plus its result (one unit). */
function toolPair(id: string, text: string): AgentMessage[] {
  return [
    fauxAssistantMessage([fauxToolCall("bash", { command: text }, id)]),
    toolResult(id, text),
  ];
}

/** `count` units of roughly `chars` characters each, plus the leading user
 * message. */
function conversation(count: number, chars: number): AgentMessage[] {
  const messages: AgentMessage[] = [user("start")];
  for (let i = 0; i < count; i++) {
    messages.push(...toolPair(`t${i}`, `${i}`.repeat(chars)));
  }
  return messages;
}

interface RecordedRequest {
  systemPrompt?: string;
  messages: readonly unknown[];
  tools?: readonly AgentTool[];
  maxOutputTokens?: number;
}

/** A stream fn that answers with `reply` and records the requests it saw. */
function recordingStreamFn(reply: string): {
  streamFn: StreamFn;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const streamFn: StreamFn = (_model, context, options) => {
    requests.push({
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      tools: context.tools,
      maxOutputTokens: options?.maxOutputTokens,
    });
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: fauxAssistantMessage(reply) });
    stream.push({ type: "text_delta", delta: reply });
    stream.end(fauxAssistantMessage(reply));
    return stream;
  };
  return { streamFn, requests };
}

/** Build a compactor that splices its checkpoint into `messages` (the same
 * shape the session agent's insert produces) and records the call. */
function compactorFor(
  messages: AgentMessage[],
  options: {
    reply?: string;
    model?: Model<Api>;
    policy?: Parameters<typeof resolveCompactionPolicy>[0];
  } = {},
): {
  compactor: ContextCompactor;
  requests: RecordedRequest[];
  inserts: Array<{ index: number; message: AgentMessage }>;
} {
  const { streamFn, requests } = recordingStreamFn(
    options.reply ?? "## Goal\n- test the compactor",
  );
  const inserts: Array<{ index: number; message: AgentMessage }> = [];
  const compactor = new ContextCompactor({
    model: options.model ?? wideModel(),
    systemPrompt: () => "You are Lumisca.",
    tools: () => [{
      name: "bash",
      label: "Bash",
      description: "Run a command",
      parameters: { type: "object" },
      execute: () => Promise.resolve({ content: [], details: {} }),
    }],
    streamFn,
    sessionId: "s1",
    ...(options.policy !== undefined ? { policy: () => options.policy! } : {}),
    insert: (index, message) => {
      inserts.push({ index, message });
      messages.splice(index, 0, message);
    },
  });
  return { compactor, requests, inserts };
}

/** The text of the single user message of a summarization request. */
function requestText(request: RecordedRequest): string {
  const message = request.messages[0] as {
    content: Array<{ text: string }>;
  };
  return message.content[0]!.text;
}

Deno.test("resolveCompactionBudgets: the threshold sits one reservation below the window", () => {
  const budgets = resolveCompactionBudgets(wideModel())!;
  assertEquals(budgets.contextWindow, 200_000);
  assertEquals(budgets.thresholdTokens, 200_000 - 16_384);
  assertEquals(budgets.keepRecentTokens, 20_000);
  // pi: 80% of the reservation, capped by the model's own output limit.
  assertEquals(budgets.summaryMaxTokens, Math.floor(16_384 * 0.8));
});

Deno.test("resolveCompactionBudgets: no window, no room, or disabled disables compaction", () => {
  const bare: Model<Api> = {
    id: "x",
    name: "x",
    api: "openai-completions",
    provider: "p",
  };
  assertEquals(resolveCompactionBudgets(bare), undefined);
  // A reservation as large as the window leaves nothing for a prompt.
  assertEquals(resolveCompactionBudgets(modelWith(10_000, 1_000)), undefined);
  assertEquals(
    resolveCompactionBudgets(modelWith(200_000, 1_000), {
      ...DEFAULT_COMPACTION_POLICY,
      enabled: false,
    }),
    undefined,
  );
});

Deno.test("resolveCompactionBudgets: a zero reservation falls back to the model's cap", () => {
  const budgets = resolveCompactionBudgets(modelWith(200_000, 8_000), {
    enabled: true,
    reserveTokens: 0,
    keepRecentTokens: 0,
  })!;
  assertEquals(budgets.thresholdTokens, 200_000);
  assertEquals(budgets.summaryMaxTokens, 8_000);
});

Deno.test("resolveCompactionPolicy falls back to pi's defaults", () => {
  const policy = resolveCompactionPolicy();
  assertEquals(policy, DEFAULT_COMPACTION_POLICY);
  // Invalid and unset values keep the defaults; explicit ones win.
  assertEquals(
    resolveCompactionPolicy({ enabled: false, reserveTokens: -5 }),
    { enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  );
  assertEquals(
    resolveCompactionPolicy({ reserveTokens: 1_000.7, keepRecentTokens: 0 }),
    { enabled: true, reserveTokens: 1_000, keepRecentTokens: 0 },
  );
});

Deno.test("transcriptUnits keeps an assistant turn with its tool results", () => {
  const messages: AgentMessage[] = [
    user("do it"),
    ...toolPair("t1", "first"),
    assistant("done"),
    user("again"),
  ];
  assertEquals(transcriptUnits(messages).map((u) => [u.index, u.count]), [
    [0, 1],
    [1, 2],
    [3, 1],
    [4, 1],
  ]);
  // `from` starts the split at the projection start.
  assertEquals(transcriptUnits(messages, 3).map((u) => [u.index, u.count]), [
    [3, 1],
    [4, 1],
  ]);
});

Deno.test("contextStart is the newest checkpoint (0 when there is none)", () => {
  const messages: AgentMessage[] = [
    user("a"),
    assistant("b"),
    { role: "checkpoint", title: "t", body: "s", timestamp: 3 } as AgentMessage,
    user("c"),
  ];
  assertEquals(contextStart(messages), 2);
  assertEquals(contextStart([user("a")]), 0);
});

Deno.test("checkpointSummaryText unwraps the framed summary", () => {
  const message = {
    role: "checkpoint",
    title: "t",
    body:
      `${CHECKPOINT_PREAMBLE}\n\n<${CHECKPOINT_SUMMARY_TAG}>\n## Goal\n- x\n</${CHECKPOINT_SUMMARY_TAG}>`,
    timestamp: 1,
  } as AgentMessage;
  assertEquals(checkpointSummaryText(message), "## Goal\n- x");
});

Deno.test("selectCompactionSpan retains the newest unit and cuts on a unit boundary", () => {
  // Units: user(0), pair(1,2), pair(3,4), pair(5,6).
  const messages = conversation(3, 4_000);
  const budgets = {
    contextWindow: 10_000,
    thresholdTokens: 2_000,
    keepRecentTokens: 100,
    summaryMaxTokens: 100,
  };
  const span = selectCompactionSpan(messages, 0, budgets)!;
  assertEquals(span.start, 0);
  assertEquals(span.cutIndex, 5);
  assertEquals(span.count, 5);
  assertEquals(span.headTokens > 0, true);
});

Deno.test("selectCompactionSpan: a single unit, or one with nothing to summarize, is refused", () => {
  const budgets = {
    contextWindow: 10_000,
    thresholdTokens: 80,
    keepRecentTokens: 10,
    summaryMaxTokens: 100,
  };
  assertEquals(selectCompactionSpan([user("only")], 0, budgets), null);
  // The projection holds only the previous checkpoint: summarizing it again
  // would churn a checkpoint without reducing a request.
  const checkpointOnly: AgentMessage[] = [
    { role: "checkpoint", title: "t", body: "s", timestamp: 1 } as AgentMessage,
    assistant("a"),
  ];
  assertEquals(selectCompactionSpan(checkpointOnly, 0, budgets), null);
});

Deno.test("selectCompactionSpan: force reduces as far as one span allows", () => {
  const messages: AgentMessage[] = [
    user("a".repeat(4_000)),
    user("b".repeat(4_000)),
    user("c".repeat(4_000)),
  ];
  const budgets = {
    contextWindow: 10_000,
    thresholdTokens: 5_000,
    keepRecentTokens: 4_000,
    summaryMaxTokens: 100,
  };
  // Without force the retention budget already covers the whole history.
  assertEquals(selectCompactionSpan(messages, 0, budgets), null);
  // Forced (overflow recovery): everything but the newest unit goes.
  const span = selectCompactionSpan(messages, 0, budgets, true)!;
  assertEquals([span.start, span.cutIndex, span.count], [0, 2, 2]);
});

Deno.test("compactIfNeeded does nothing below the pressure threshold", async () => {
  const messages: AgentMessage[] = [user("short"), assistant("ok")];
  const { compactor, requests, inserts } = compactorFor(messages);
  assertEquals(await compactor.compactIfNeeded(messages), null);
  assertEquals(requests.length, 0);
  assertEquals(inserts.length, 0);
});

Deno.test("compactIfNeeded inserts a checkpoint at the cut and keeps every message", async () => {
  const messages = conversation(3, 16_000);
  const before = [...messages];
  const { compactor, requests, inserts } = compactorFor(messages, {
    model: modelWith(10_000, 2_000),
    policy: { reserveTokens: 2_000, keepRecentTokens: 100 },
  });
  const result = await compactor.compactIfNeeded(messages);
  assertEquals(result !== null, true);
  // Nothing was deleted: the checkpoint was inserted where the retained
  // tail starts, and the summarized messages are still there.
  assertEquals(inserts.length, 1);
  assertEquals(messages.length, before.length + 1);
  assertEquals(result!.index, 5);
  assertEquals(messages[5]!.role, "checkpoint");
  assertEquals(result!.summarized.length, 5);
  assertEquals(result!.summarized, before.slice(0, 5));
  assertEquals(result!.freedTokens > 0, true);
  // The model's view starts at the checkpoint (the older messages are kept
  // but no longer sent).
  assertEquals(contextStart(messages), 5);
  assertEquals(requests.length, 1);
});

Deno.test("the summarization request is a dedicated, tool-free call", async () => {
  const messages = conversation(2, 4_000);
  const { compactor, requests } = compactorFor(messages, {
    model: modelWith(10_000, 2_000),
    policy: { reserveTokens: 2_000, keepRecentTokens: 100 },
  });
  await compactor.compactNow(messages);
  assertEquals(requests.length, 1);
  const request = requests[0]!;
  assertEquals(request.systemPrompt, SUMMARIZATION_SYSTEM_PROMPT);
  assertEquals(request.tools, undefined);
  assertEquals(request.maxOutputTokens, Math.floor(2_000 * 0.8));
  const text = requestText(request);
  // The head is serialized (not replayed as roles), framed, and followed by
  // pi's instruction.
  assertEquals(text.startsWith("<conversation>"), true);
  assertEquals(text.includes("[User]: start"), true);
  assertEquals(text.includes("[Assistant tool calls]:"), true);
  assertEquals(text.includes("[Tool result]:"), true);
  assertEquals(text.includes(SUMMARIZATION_PROMPT), true);
  assertEquals(text.includes("<previous-summary>"), false);
});

Deno.test("a second compaction merges the previous summary", async () => {
  const messages = conversation(2, 4_000);
  const { compactor, requests } = compactorFor(messages, {
    model: modelWith(10_000, 2_000),
    policy: { reserveTokens: 2_000, keepRecentTokens: 100 },
  });
  await compactor.compactNow(messages);
  assertEquals(requests.length, 1);
  // More work arrives; the projection now starts at the checkpoint.
  messages.push(...toolPair("t9", "z".repeat(4_000)));
  const second = await compactor.compactNow(messages);
  assertEquals(second !== null, true);
  assertEquals(requests.length, 2);
  const text = requestText(requests[1]!);
  assertEquals(text.includes("<previous-summary>"), true);
  assertEquals(text.includes("## Goal"), true);
  assertEquals(text.includes(UPDATE_SUMMARIZATION_PROMPT), true);
  assertEquals(text.includes(SUMMARIZATION_PROMPT), false);
  // The previous checkpoint itself is not replayed as a message.
  assertEquals(text.includes(CHECKPOINT_PREAMBLE), false);
});

Deno.test("custom instructions steer the summary", async () => {
  const messages = conversation(2, 4_000);
  const { compactor, requests } = compactorFor(messages, {
    model: modelWith(10_000, 2_000),
    policy: { reserveTokens: 2_000, keepRecentTokens: 100 },
  });
  await compactor.compactNow(messages, "  keep the file paths  ");
  assertEquals(requests.length, 1);
  const text = requestText(requests[0]!);
  assertEquals(text.includes("Additional focus: keep the file paths"), true);
});

Deno.test("compactIfNeeded leaves the transcript untouched when summarization fails", async () => {
  const messages = conversation(3, 4_000);
  const before = [...messages];
  const failingStreamFn: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "error", errorMessage: "boom" });
    stream.end();
    return stream;
  };
  const inserts: unknown[] = [];
  const compactor = new ContextCompactor({
    model: modelWith(10_000, 2_000),
    systemPrompt: () => "prompt",
    tools: () => [],
    streamFn: failingStreamFn,
    sessionId: "s1",
    policy: () => ({ reserveTokens: 2_000, keepRecentTokens: 100 }),
    insert: (index, message) => inserts.push({ index, message }),
  });
  assertEquals(await compactor.compactIfNeeded(messages), null);
  assertEquals(inserts.length, 0);
  assertEquals(messages, before);
});

Deno.test("compactIfNeeded refuses a summary that does not shrink its source", async () => {
  const messages = conversation(2, 4_000);
  const before = [...messages];
  const { compactor, inserts } = compactorFor(messages, {
    reply: "s".repeat(40_000),
    model: modelWith(10_000, 2_000),
    policy: { reserveTokens: 2_000, keepRecentTokens: 100 },
  });
  assertEquals(await compactor.compactIfNeeded(messages), null);
  assertEquals(inserts.length, 0);
  assertEquals(messages, before);
});

Deno.test("compactNow condenses below the threshold on demand", async () => {
  const messages = conversation(2, 4_000);
  // The retention budget must be smaller than the conversation, otherwise
  // there is nothing left to summarize (the default 20k keeps it all).
  const { compactor, inserts } = compactorFor(messages, {
    policy: { reserveTokens: 2_000, keepRecentTokens: 100 },
  });
  const result = await compactor.compactNow(messages);
  assertEquals(result !== null, true);
  assertEquals(inserts.length, 1);
  assertEquals(messages[0]!.role, "user");
  assertEquals(messages[inserts[0]!.index]!.role, "checkpoint");
  // Only the newest unit is retained.
  assertEquals(messages.at(-1)!.role, "toolResult");
});

Deno.test("compactNow does nothing when no safe span exists", async () => {
  const messages: AgentMessage[] = [user("only")];
  const { compactor, requests, inserts } = compactorFor(messages);
  assertEquals(await compactor.compactNow(messages), null);
  assertEquals(requests.length, 0);
  assertEquals(inserts.length, 0);
});

Deno.test("compactNow refuses a span too small to reduce a request", async () => {
  // Two tiny units: summarizing them would cost a call and free nothing.
  const messages: AgentMessage[] = [user("a"), assistant("b")];
  const { compactor, requests, inserts } = compactorFor(messages);
  assertEquals(await compactor.compactNow(messages), null);
  assertEquals(requests.length, 0);
  assertEquals(inserts.length, 0);
});

Deno.test("measure anchors on provider usage and estimates only the delta", () => {
  const messages: AgentMessage[] = [user("start"), assistant("ok")];
  const { compactor } = compactorFor(messages);
  const full = compactor.measure(messages);
  assertEquals(full > 0, true);
  messages.push(fauxAssistantMessage([fauxText("second")], {
    usage: { input: 150_000, output: 10, cacheRead: 0, cacheWrite: 0 },
  }));
  compactor.observeTurn(messages);
  const anchored = compactor.measure(messages);
  assertEquals(anchored >= 150_000, true);
  assertEquals(anchored < 160_000, true);
});

Deno.test("measure only counts the model's view, not the kept-but-hidden history", async () => {
  const messages = conversation(2, 4_000);
  const { compactor } = compactorFor(messages, {
    model: modelWith(10_000, 2_000),
    policy: { reserveTokens: 2_000, keepRecentTokens: 100 },
  });
  const before = compactor.measure(messages);
  await compactor.compactNow(messages);
  const after = compactor.measure(messages);
  // The transcript GREW by the checkpoint, yet the measured view shrank:
  // the summarized messages are still stored but no longer sent.
  assertEquals(messages.length, 6);
  assertEquals(after < before, true);
});

Deno.test("an insertion invalidates the measurement anchor", async () => {
  const messages = conversation(3, 4_000);
  const { compactor } = compactorFor(messages, {
    model: modelWith(10_000, 2_000),
    policy: { reserveTokens: 2_000, keepRecentTokens: 100 },
  });
  compactor.observeTurn(messages);
  await compactor.compactIfNeeded(messages);
  // The old anchor described a projection that no longer exists: the next
  // measurement must be a fresh estimate, not the stale figure.
  const measured = compactor.measure(messages);
  assertEquals(measured > 0, true);
  assertEquals(measured < 10_000, true);
});

Deno.test("compaction re-entrancy is refused while a summarization runs", async () => {
  const messages = conversation(3, 4_000);
  const { compactor } = compactorFor(messages, {
    model: modelWith(10_000, 2_000),
    policy: { reserveTokens: 2_000, keepRecentTokens: 100 },
  });
  const first = compactor.compactIfNeeded(messages);
  // A nested call (the summarization request's own step) must not start a
  // second transaction.
  assertEquals(await compactor.compactIfNeeded(messages), null);
  await first;
});
