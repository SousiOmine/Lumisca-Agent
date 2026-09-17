import { assertEquals } from "@std/assert";
import { Agent } from "../ai/agent.ts";
import { createAssistantMessageEventStream } from "../ai/event-stream.ts";
import { fauxAssistantMessage, fauxToolCall } from "../ai/faux.ts";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  Api,
  AssistantMessage,
  Model,
  StreamFn,
  ToolCall,
  ToolResultMessage,
} from "../ai/types.ts";
import { createStreamFn, type StreamTransport } from "../ai/stream.ts";
import { toAgentTool } from "../tools/pi-adapter.ts";
import { object, string, type Tool } from "../tools/schema.ts";

function fakeModel(): Model<Api> {
  return {
    id: "m",
    name: "m",
    api: "openai-completions",
    provider: "faux",
  } as unknown as Model<Api>;
}

const echoSchema = object({ text: string("Text to echo") });

/** A tool whose executions are counted, so double execution is observable. */
function countingEchoTool(counter: { calls: number }): Tool<typeof echoSchema> {
  return {
    name: "echo",
    label: "Echo",
    description: "Echo the text back.",
    parameters: echoSchema,
    execute: (_id, params) => {
      counter.calls++;
      return Promise.resolve({
        content: [{ type: "text", text: `echo:${params.text}` }],
        details: {},
      });
    },
  };
}

/** Serve one scripted StreamFn event list per LLM call. */
function scriptedStreamFn(
  scripts: Array<
    (stream: ReturnType<typeof createAssistantMessageEventStream>) => void
  >,
): StreamFn {
  let index = 0;
  return () => {
    const stream = createAssistantMessageEventStream();
    scripts[index++]!(stream);
    return stream;
  };
}

function toolStartArgs(events: AgentEvent[]): unknown[] {
  return events
    .filter((e) => e.type === "tool_execution_start")
    .map((e) => (e as { args: unknown }).args);
}

Deno.test("SDK-executed tools keep their args and are not re-executed", async () => {
  const counter = { calls: 0 };
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "t1",
    name: "echo",
    arguments: { text: "hi" },
  };
  const toolTurn: AssistantMessage = {
    ...fauxAssistantMessage([toolCall], { stopReason: "toolUse" }),
  };
  const events: AgentEvent[] = [];
  const streamFn = scriptedStreamFn([
    (s) => {
      // What the fixed Vercel transport yields for one SDK-executed turn:
      // start → toolcall_start (real args) → toolcall_result → done.
      s.push({ type: "start", partial: fauxAssistantMessage("") });
      s.push({
        type: "toolcall_start",
        toolCallId: "t1",
        toolName: "echo",
        args: { text: "hi" },
      });
      s.push({
        type: "toolcall_result",
        toolCallId: "t1",
        toolName: "echo",
        content: [{ type: "text", text: "echo:hi" }],
        details: { matches: 2 },
        isError: false,
      });
      s.push({ type: "done", message: toolTurn });
      s.end(toolTurn);
    },
    (s) => {
      const done = fauxAssistantMessage("done");
      s.push({ type: "start", partial: done });
      s.push({ type: "done", message: done });
      s.end(done);
    },
  ]);
  const agent = new Agent({
    initialState: {
      systemPrompt: "test",
      model: fakeModel(),
      tools: [toAgentTool(countingEchoTool(counter))],
      thinkingLevel: "off",
    },
    streamFn,
    sessionId: "s1",
  });
  agent.subscribe((e) => events.push(e));

  await agent.prompt("hello");

  // The Agent must not run the tool itself: the SDK already did.
  assertEquals(counter.calls, 0);
  // The UI saw the real arguments, not {}.
  assertEquals(toolStartArgs(events), [{ text: "hi" }]);

  const messages: AgentMessage[] = agent.messages;
  const assistantIndex = messages.findIndex((m) =>
    m.role === "assistant" &&
    (m as AssistantMessage).content.some((b) => b.type === "toolCall")
  );
  const resultIndex = messages.findIndex((m) =>
    m.role === "toolResult" &&
    (m as { toolCallId?: string }).toolCallId === "t1"
  );
  // Transcript order stays assistant(toolCalls) → toolResults.
  assertEquals(
    assistantIndex !== -1 && resultIndex !== -1 && assistantIndex < resultIndex,
    true,
  );
  const assistant = messages[assistantIndex] as AssistantMessage;
  const recorded = assistant.content.find((b) =>
    b.type === "toolCall"
  ) as ToolCall;
  assertEquals(recorded.arguments, { text: "hi" });

  // The result's details survive the trip: the transcript keeps them (the
  // UI rebuilds the badge from the stored message on a reload) and the live
  // event carries the same value.
  const recordedResult = messages[resultIndex] as ToolResultMessage;
  assertEquals(recordedResult.details, { matches: 2 });
  const end = events.find((e) =>
    e.type === "tool_execution_end" &&
    (e as { toolCallId?: string }).toolCallId === "t1"
  ) as { result: { details: unknown } };
  assertEquals(end.result.details, { matches: 2 });
});

Deno.test("tool calls without SDK results still run via the fallback", async () => {
  const counter = { calls: 0 };
  const events: AgentEvent[] = [];
  const streamFn = scriptedStreamFn([
    (s) => {
      // Faux-style stream: only start(partial) + end, no SDK result events.
      const toolTurn = fauxAssistantMessage(
        [fauxToolCall("echo", { text: "yo" }, "t9")],
        { stopReason: "toolUse" },
      );
      s.push({ type: "start", partial: toolTurn });
      s.end(toolTurn);
    },
    (s) => {
      const done = fauxAssistantMessage("done");
      s.push({ type: "start", partial: done });
      s.end(done);
    },
  ]);
  const agent = new Agent({
    initialState: {
      systemPrompt: "test",
      model: fakeModel(),
      tools: [toAgentTool(countingEchoTool(counter))],
      thinkingLevel: "off",
    },
    streamFn,
    sessionId: "s1",
  });
  agent.subscribe((e) => events.push(e));

  await agent.prompt("hello");

  assertEquals(counter.calls, 1);
  assertEquals(toolStartArgs(events), [{ text: "yo" }]);
});

// ---- real transport --------------------------------------------------------

/** The fake provider stream parts of one tool call (v2 shape: the arguments
 * arrive as JSON text). */
function toolCallParts(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): unknown[] {
  return [
    { type: "tool-input-start", id: toolCallId, toolName },
    { type: "tool-input-delta", id: toolCallId, delta: JSON.stringify(input) },
    { type: "tool-input-end", id: toolCallId },
    {
      type: "tool-call",
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    },
    { type: "finish", finishReason: "tool-calls", usage: usage() },
  ];
}

/** The fake provider stream parts of one plain answer. */
function answerParts(text: string): unknown[] {
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", usage: usage() },
  ];
}

function usage() {
  return { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 };
}

/** A fake v2 provider serving one scripted stream per call, recording the
 * prompt each call received (what the model is really asked). */
function scriptedLanguageModel(scripts: unknown[][]) {
  const prompts: unknown[] = [];
  let call = 0;
  const model = {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "m",
    supportedUrls: {},
    doGenerate: () => {
      throw new Error("not used");
    },
    doStream: (options: { prompt?: unknown }) => {
      prompts.push(options.prompt);
      const parts = scripts[call++] ?? [];
      return {
        stream: new ReadableStream<unknown>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
        request: {},
        response: {},
      };
    },
  };
  return { model, prompts };
}

/** The whole path end to end: the Agent drives the real transport, the SDK
 * executes the tool, and the result reaches both audiences 窶・the UI (the
 * details) and the model (the text alone). */
Deno.test("the tool result keeps its details for the UI and stays text for the model", async () => {
  const call = { args: undefined as unknown };
  const editTool: AgentTool = {
    name: "edit",
    label: "Edit File",
    description: "Replace text in a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
    },
    execute: (_id, params) => {
      call.args = params;
      return Promise.resolve({
        content: [{ type: "text" as const, text: "Edited a.ts" }],
        // The counts the web UI renders as the `+3 -2` badge.
        details: { path: "a.ts", addedLines: 3, removedLines: 2 },
      });
    },
  };
  const fake = scriptedLanguageModel([
    toolCallParts("t1", "edit", { path: "a.ts" }),
    answerParts("done"),
  ]);
  const transport: StreamTransport = {
    languageModelFor: () => Promise.resolve(fake.model as never),
  };
  const agent = new Agent({
    initialState: {
      systemPrompt: "test",
      model: fakeModel(),
      tools: [editTool],
      thinkingLevel: "off",
    },
    streamFn: createStreamFn(transport),
    sessionId: "s1",
  });

  await agent.prompt("edit a.ts");

  // The tool ran once, with the model's arguments.
  assertEquals(call.args, { path: "a.ts" });
  // The transcript (and therefore the DB, and the UI after a reload)
  // carries the details the badge reads.
  const result = agent.messages.find((m) =>
    m.role === "toolResult"
  ) as ToolResultMessage;
  assertEquals(result.details, {
    path: "a.ts",
    addedLines: 3,
    removedLines: 2,
  });
  assertEquals(result.content, [{ type: "text", text: "Edited a.ts" }]);
  // The model was asked twice (tool call, then the answer) and the second
  // request carries the result text 窶・never the UI's details envelope.
  assertEquals(fake.prompts.length, 2);
  const secondPrompt = JSON.stringify(fake.prompts[1]);
  assertEquals(secondPrompt.includes("Edited a.ts"), true);
  assertEquals(secondPrompt.includes("addedLines"), false);
});
