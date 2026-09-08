import { assertEquals } from "@std/assert";
import {
  Agent,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
} from "@lumisca/core";
import type {
  AgentEvent,
  AgentMessage,
  Api,
  AssistantMessage,
  Model,
  StreamFn,
  ToolCall,
} from "@lumisca/core";
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
