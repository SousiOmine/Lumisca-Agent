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
  CHECKPOINT_SUMMARY_TAG,
  COMPACTION_INSTRUCTION,
  ContextCompactor,
  DEFAULT_COMPACTION_POLICY,
  resolveCompactionBudgets,
  resolveCompactionPolicy,
  selectCompactionSpan,
  transcriptUnits,
} from "./context-compaction.ts";

/** A model with a 1M window reserving a 384K completion — the shape that
 * made the original failure possible (prompt + completion is validated
 * together), so the budgets must come out of `window - outputCap`. */
function bigModel(): Model<Api> {
  return {
    id: "test-model",
    name: "Test",
    api: "openai-completions",
    provider: "test",
    contextWindow: 1_000_000,
    maxTokens: 384_000,
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

/** A stream fn that answers with `reply` and records the requests it saw. */
function recordingStreamFn(reply: string): {
  streamFn: StreamFn;
  requests: Array<{
    systemPrompt?: string;
    messages: readonly unknown[];
    tools?: readonly AgentTool[];
    maxOutputTokens?: number;
  }>;
} {
  const requests: Array<{
    systemPrompt?: string;
    messages: readonly unknown[];
    tools?: readonly AgentTool[];
    maxOutputTokens?: number;
  }> = [];
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

/** Build a compactor whose replacements are recorded, over a stub stream. */
function compactorFor(
  messages: AgentMessage[],
  options: {
    reply?: string;
    model?: Model<Api>;
    onReplace?: (index: number, count: number, message: AgentMessage) => void;
  } = {},
): {
  compactor: ContextCompactor;
  requests: ReturnType<typeof recordingStreamFn>["requests"];
  replacements: Array<{ index: number; count: number; message: AgentMessage }>;
} {
  const { streamFn, requests } = recordingStreamFn(
    options.reply ?? "## Summary\n- did things",
  );
  const replacements: Array<{
    index: number;
    count: number;
    message: AgentMessage;
  }> = [];
  const compactor = new ContextCompactor({
    model: options.model ?? bigModel(),
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
    replace: (index, count, message) => {
      replacements.push({ index, count, message });
      messages.splice(index, count, message);
      options.onReplace?.(index, count, message);
    },
  });
  return { compactor, requests, replacements };
}

Deno.test("resolveCompactionBudgets reserves the model's completion cap", () => {
  const budgets = resolveCompactionBudgets(bigModel())!;
  // 1M window minus the 384K completion the request reserves.
  assertEquals(budgets.usableInputTokens, 616_000);
  assertEquals(
    budgets.thresholdTokens,
    Math.floor(616_000 * DEFAULT_COMPACTION_POLICY.thresholdRatio),
  );
  assertEquals(
    budgets.retainTokens,
    Math.floor(616_000 * DEFAULT_COMPACTION_POLICY.retainRatio),
  );
});

Deno.test("resolveCompactionBudgets: no window or no room disables compaction", () => {
  assertEquals(
    resolveCompactionBudgets({
      id: "x",
      name: "x",
      api: "openai-completions",
      provider: "p",
    }),
    undefined,
  );
  // A completion cap as large as the window leaves nothing for a prompt.
  assertEquals(
    resolveCompactionBudgets({
      id: "x",
      name: "x",
      api: "openai-completions",
      provider: "p",
      contextWindow: 1000,
      maxTokens: 1000,
    }),
    undefined,
  );
});

Deno.test("resolveCompactionBudgets: the retained tail never fills the threshold", () => {
  // A model whose retain ratio would exceed half the threshold is clamped.
  const budgets = resolveCompactionBudgets(
    {
      id: "x",
      name: "x",
      api: "openai-completions",
      provider: "p",
      contextWindow: 10_000,
    },
    { ...DEFAULT_COMPACTION_POLICY, retainRatio: 0.9 },
  )!;
  assertEquals(budgets.retainTokens, Math.floor(budgets.thresholdTokens / 2));
});

Deno.test("resolveCompactionPolicy returns the documented defaults", () => {
  const policy = resolveCompactionPolicy(bigModel());
  assertEquals(policy.thresholdRatio, 0.8);
  assertEquals(policy.retainRatio, 0.16);
  assertEquals(policy.compactionRetries, 1);
  assertEquals(policy.summarizationMaxTokens, 8192);
});

Deno.test("transcriptUnits keeps an assistant turn with its tool results", () => {
  const messages: AgentMessage[] = [
    user("do it"),
    ...toolPair("t1", "first"),
    assistant("done"),
    user("again"),
  ];
  const units = transcriptUnits(messages);
  assertEquals(units.map((u) => [u.index, u.count]), [
    [0, 1],
    [1, 2],
    [3, 1],
    [4, 1],
  ]);
});

Deno.test("selectCompactionSpan retains the newest unit and cuts on a unit boundary", () => {
  // Units: user(0), pair(1,2), pair(3,4) — each pair carries a big payload.
  const messages: AgentMessage[] = [
    user("start"),
    ...toolPair("t1", "x".repeat(4000)),
    ...toolPair("t2", "y".repeat(4000)),
  ];
  const budgets = {
    usableInputTokens: 2500,
    thresholdTokens: 2000,
    retainTokens: 200,
    outputCapTokens: 0,
  };
  const span = selectCompactionSpan(messages, budgets)!;
  // The newest unit (index 3, count 2) is retained; everything before it is
  // replaced, and the cut never splits the tool pair.
  assertEquals(span.index, 0);
  assertEquals(span.count, 3);
});

Deno.test("selectCompactionSpan: a single unit is never compacted", () => {
  const messages: AgentMessage[] = [user("only")];
  const budgets = {
    usableInputTokens: 100,
    thresholdTokens: 80,
    retainTokens: 10,
    outputCapTokens: 0,
  };
  assertEquals(selectCompactionSpan(messages, budgets), null);
});

Deno.test("selectCompactionSpan: force reduces as far as one span allows", () => {
  const messages: AgentMessage[] = [
    user("a".repeat(4000)),
    user("b".repeat(4000)),
    user("c".repeat(4000)),
  ];
  const budgets = {
    usableInputTokens: 6000,
    thresholdTokens: 5000,
    retainTokens: 4000,
    outputCapTokens: 0,
  };
  // Without force the retention budget already covers the whole history.
  assertEquals(selectCompactionSpan(messages, budgets), null);
  // Forced (overflow recovery): everything but the newest unit goes.
  const span = selectCompactionSpan(messages, budgets, true)!;
  assertEquals([span.index, span.count], [0, 2]);
});

Deno.test("compactIfNeeded does nothing below the pressure threshold", async () => {
  const messages: AgentMessage[] = [user("short"), assistant("ok")];
  const { compactor, requests, replacements } = compactorFor(messages);
  assertEquals(await compactor.compactIfNeeded(messages), null);
  assertEquals(requests.length, 0);
  assertEquals(replacements.length, 0);
});

Deno.test("compactIfNeeded replaces the oldest span above the threshold", async () => {
  const payload = "x".repeat(4000);
  const messages: AgentMessage[] = [
    user("start"),
    ...toolPair("t1", payload),
    ...toolPair("t2", payload),
    ...toolPair("t3", payload),
  ];
  const { compactor, requests, replacements } = compactorFor(messages, {
    model: {
      id: "small",
      name: "small",
      api: "openai-completions",
      provider: "p",
      contextWindow: 2000,
      maxTokens: 500,
    },
  });
  const result = await compactor.compactIfNeeded(messages);
  assertEquals(result !== null, true);
  assertEquals(replacements.length, 1);
  // The checkpoint sits where the replaced span began and carries the
  // framed summary.
  const checkpoint = messages[0]!;
  assertEquals(checkpoint.role, "checkpoint");
  assertEquals(
    (checkpoint as { body: string }).body.includes(CHECKPOINT_SUMMARY_TAG),
    true,
  );
  // The summarization request replays the session's own prompt and tools,
  // appends the instruction, and caps its own completion.
  assertEquals(requests.length, 1);
  assertEquals(requests[0]!.systemPrompt, "You are Lumisca.");
  assertEquals(requests[0]!.tools?.length, 1);
  assertEquals(requests[0]!.maxOutputTokens, 8192);
  const last = requests[0]!.messages.at(-1) as {
    role: string;
    content: Array<{ text: string }>;
  };
  assertEquals(last.role, "user");
  assertEquals(last.content[0]!.text, COMPACTION_INSTRUCTION);
  // The replayed span keeps the tool call/result pairing intact.
  const roles = requests[0]!.messages.map((m) => (m as { role: string }).role);
  assertEquals(roles.includes("toolResult"), true);
  // The newest unit survived: the model still sees the work in progress.
  assertEquals(messages.at(-1)!.role, "toolResult");
  assertEquals(result!.removed.length > 0, true);
});

Deno.test("compactIfNeeded leaves the transcript untouched when summarization fails", async () => {
  const payload = "x".repeat(4000);
  const messages: AgentMessage[] = [
    user("start"),
    ...toolPair("t1", payload),
    ...toolPair("t2", payload),
    ...toolPair("t3", payload),
  ];
  const failingStreamFn: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "error", errorMessage: "boom" });
    stream.end();
    return stream;
  };
  const replacements: unknown[] = [];
  const compactor = new ContextCompactor({
    model: {
      id: "small",
      name: "small",
      api: "openai-completions",
      provider: "p",
      contextWindow: 2000,
      maxTokens: 500,
    },
    systemPrompt: () => "prompt",
    tools: () => [],
    streamFn: failingStreamFn,
    sessionId: "s1",
    replace: (index, count, message) => {
      replacements.push({ index, count, message });
      messages.splice(index, count, message);
    },
  });
  const before = [...messages];
  assertEquals(await compactor.compactIfNeeded(messages), null);
  assertEquals(replacements.length, 0);
  assertEquals(messages, before);
});

Deno.test("compactIfNeeded refuses a summary that does not shrink its source", async () => {
  const messages: AgentMessage[] = [user("a"), assistant("b")];
  const { compactor, replacements } = compactorFor(messages, {
    reply: "s".repeat(5000),
    model: {
      id: "small",
      name: "small",
      api: "openai-completions",
      provider: "p",
      contextWindow: 2000,
      maxTokens: 500,
    },
  });
  assertEquals(await compactor.compactIfNeeded(messages), null);
  assertEquals(replacements.length, 0);
  assertEquals(messages.length, 2);
});

Deno.test("compactNow condenses below the threshold on demand", async () => {
  const messages: AgentMessage[] = [
    user("start"),
    ...toolPair("t1", "x".repeat(4000)),
    ...toolPair("t2", "y".repeat(4000)),
  ];
  const { compactor, replacements } = compactorFor(messages, {
    model: {
      id: "small",
      name: "small",
      api: "openai-completions",
      provider: "p",
      contextWindow: 2000,
      maxTokens: 500,
    },
  });
  const result = await compactor.compactNow(messages);
  assertEquals(result !== null, true);
  assertEquals(replacements.length, 1);
  // Only the newest unit is retained.
  assertEquals(messages.at(-1)!.role, "toolResult");
  assertEquals(messages[0]!.role, "checkpoint");
});

Deno.test("compactNow does nothing when no safe span exists", async () => {
  const messages: AgentMessage[] = [user("only")];
  const { compactor, requests, replacements } = compactorFor(messages);
  assertEquals(await compactor.compactNow(messages), null);
  assertEquals(requests.length, 0);
  assertEquals(replacements.length, 0);
});

Deno.test("compactNow refuses a span too small to reduce a request", async () => {
  // Two tiny units: summarizing them would cost a call and free nothing.
  const messages: AgentMessage[] = [user("a"), assistant("b")];
  const { compactor, requests, replacements } = compactorFor(messages);
  assertEquals(await compactor.compactNow(messages), null);
  assertEquals(requests.length, 0);
  assertEquals(replacements.length, 0);
});

Deno.test("compactIfNeeded refuses a span that is only a previous checkpoint", async () => {
  const payload = "x".repeat(4000);
  const messages: AgentMessage[] = [
    user("start"),
    ...toolPair("t1", payload),
    ...toolPair("t2", payload),
    ...toolPair("t3", payload),
  ];
  const model: Model<Api> = {
    id: "small",
    name: "small",
    api: "openai-completions",
    provider: "p",
    contextWindow: 2000,
    maxTokens: 500,
  };
  const { compactor, replacements } = compactorFor(messages, { model });
  await compactor.compactIfNeeded(messages);
  assertEquals(replacements.length, 1);
  // The history now starts with the checkpoint: a second compaction would
  // only summarize the summary, so it is refused.
  assertEquals(await compactor.compactIfNeeded(messages), null);
  assertEquals(replacements.length, 1);
});

Deno.test("measure anchors on provider usage and estimates only the delta", () => {
  const messages: AgentMessage[] = [user("start"), assistant("ok")];
  const { compactor } = compactorFor(messages);
  // No usage reported yet: the whole envelope plus the transcript.
  const full = compactor.measure(messages);
  assertEquals(full > 0, true);
  // A provider-reported prompt replaces the transcript estimate: the
  // measured request is the reported figure plus what followed the turn.
  messages.push(fauxAssistantMessage([fauxText("second")], {
    usage: { input: 500_000, output: 10, cacheRead: 0, cacheWrite: 0 },
  }));
  compactor.observeTurn(messages);
  const anchored = compactor.measure(messages);
  assertEquals(anchored >= 500_000, true);
  assertEquals(anchored < 520_000, true);
});

Deno.test("a replacement invalidates the measurement anchor", async () => {
  const payload = "x".repeat(4000);
  const messages: AgentMessage[] = [
    user("start"),
    ...toolPair("t1", payload),
    ...toolPair("t2", payload),
    ...toolPair("t3", payload),
  ];
  const model: Model<Api> = {
    id: "small",
    name: "small",
    api: "openai-completions",
    provider: "p",
    contextWindow: 2000,
    maxTokens: 500,
  };
  const { compactor } = compactorFor(messages, { model });
  compactor.observeTurn(messages);
  await compactor.compactIfNeeded(messages);
  // The old anchor described a transcript that no longer exists: the next
  // measurement must be a full estimate again, not the stale figure.
  const measured = compactor.measure(messages);
  assertEquals(measured > 0, true);
  assertEquals(measured < 1_000_000, true);
});

Deno.test("compaction re-entrancy is refused while a summarization runs", async () => {
  const payload = "x".repeat(4000);
  const messages: AgentMessage[] = [
    user("start"),
    ...toolPair("t1", payload),
    ...toolPair("t2", payload),
    ...toolPair("t3", payload),
  ];
  const model: Model<Api> = {
    id: "small",
    name: "small",
    api: "openai-completions",
    provider: "p",
    contextWindow: 2000,
    maxTokens: 500,
  };
  const { compactor } = compactorFor(messages, { model });
  const first = compactor.compactIfNeeded(messages);
  // A nested call (the summarization request's own step) must not start a
  // second transaction.
  assertEquals(await compactor.compactIfNeeded(messages), null);
  await first;
});
