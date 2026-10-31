import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { Agent } from "../ai/agent.ts";
import { createAssistantMessageEventStream } from "../ai/event-stream.ts";
import { fauxAssistantMessage, fauxToolCall } from "../ai/faux.ts";
import { languageModelFor } from "../ai/lang-model.ts";
import { bytesToBase64 } from "../base64.ts";
import { MINI_PNG, withTempDir } from "../test-utils.ts";
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
import { createReadFileTool } from "../tools/filesystem.ts";
import { HostFileBackend } from "../tools/host/files.ts";
import { toAgentTool } from "../tools/pi-adapter.ts";
import { object, string, type Tool } from "../tools/schema.ts";
import { contentText } from "../shared/mod.ts";
import { Sandbox } from "../workspace/sandbox.ts";

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
  // message carries the same value — the tool_end event deliberately does
  // not (one payload, one carrier).
  const recordedResult = messages[resultIndex] as ToolResultMessage;
  assertEquals(recordedResult.details, { matches: 2 });

  // The result is announced as a message of its own — the live client
  // renders the checkmark and the `+N -M` badge from the toolResult message,
  // so a result that only exists in the transcript leaves the tool line
  // unmarked until the view happens to re-sync.
  const announced = events
    .filter((e) => e.type === "message_end" && e.message.role === "toolResult")
    .map((e) => (e as { message: unknown }).message);
  assertEquals(announced, [recordedResult]);
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
  // The fallback path announces its result too: the live UI builds the tool
  // line's checkmark and its `+N -M` badge from the toolResult message, so a
  // result the client is never told about leaves the line unmarked until the
  // next transcript resync.
  assertEquals(
    events.filter((e) =>
      e.type === "message_end" && e.message.role === "toolResult"
    ).length,
    1,
  );
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
 * executes the tool, and the result reaches both audiences —the UI (the
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
  // request carries the result text —never the UI's details envelope.
  assertEquals(fake.prompts.length, 2);
  const secondPrompt = JSON.stringify(fake.prompts[1]);
  assertEquals(secondPrompt.includes("Edited a.ts"), true);
  assertEquals(secondPrompt.includes("addedLines"), false);
});

// ---- stop while the SDK runs a tool ---------------------------------------

Deno.test("a stop during an SDK-executed tool leaves a session that still runs", async () => {
  // The reported failure: the SDK executes the tool, the tool ignores the
  // abort signal (a silent MCP server, a hung `eval`), and the stop button
  // looked like it worked while the session never ran again. Two things must
  // hold: the run settles, and the next request is accepted (a tool call
  // without a result is rejected by the provider).
  const stuck: AgentTool = {
    name: "stuck",
    label: "Stuck",
    description: "Never returns and ignores the abort signal.",
    parameters: { type: "object", properties: {} },
    execute: () => new Promise(() => {}),
  };
  const fake = scriptedLanguageModel([
    toolCallParts("t1", "stuck", {}),
    answerParts("after the stop"),
  ]);
  const agent = new Agent({
    initialState: {
      systemPrompt: "test",
      model: fakeModel(),
      tools: [stuck],
      thinkingLevel: "off",
    },
    streamFn: createStreamFn({
      languageModelFor: () => Promise.resolve(fake.model as never),
    }),
    sessionId: "s1",
  });

  const first = agent.prompt("go");
  // Let the request reach the tool.
  await new Promise((resolve) => setTimeout(resolve, 50));
  agent.abort();
  await Promise.race([
    first,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("the run did not settle")), 2_000)
    ),
  ]);
  assertEquals(agent.isStreaming, false);

  // The next turn is accepted and answered: whatever the stop left behind
  // (a dangling tool call, or nothing at all when the SDK ended on an
  // `abort` part) must not poison the next request. `prompt` resolves when
  // the run settles — the run here is the SECOND one, whose first turn has
  // no tool calls.
  await agent.prompt("again");
  const last = agent.messages.at(-1) as AssistantMessage;
  assertEquals(contentText(last.content), "after the stop");
  // Every tool call in the transcript has its result.
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of agent.messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") calls.add(block.id);
      }
    } else if (message.role === "toolResult") {
      results.add(message.toolCallId);
    }
  }
  assertEquals([...calls].filter((id) => !results.has(id)), []);
});

// ---- read tool images through the whole path ------------------------------

/** An OpenAI-compatible streaming chunk. */
function chatChunk(
  delta: Record<string, unknown>,
  finish: string | null,
): Record<string, unknown> {
  return {
    id: "chatcmpl-tool-image",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/** An SSE body of the given chunks. */
function sse(chunks: Array<Record<string, unknown>>): Response {
  return new Response(
    `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}` +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** The answer of a model that calls `name` with `args`. */
function toolCallAnswer(
  id: string,
  name: string,
  args: Record<string, unknown>,
): Response {
  return sse([
    chatChunk({
      role: "assistant",
      tool_calls: [{
        index: 0,
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      }],
    }, null),
    chatChunk({}, "tool_calls"),
  ]);
}

/** The answer of a model that just says `text`. */
function textAnswer(text: string): Response {
  return sse([
    chatChunk({ role: "assistant", content: text }, null),
    chatChunk({}, "stop"),
  ]);
}

/** A local OpenAI-compatible endpoint serving one scripted answer per
 * request and recording every request body (what the provider was really
 * asked). Its requests go through the app's own provider construction (see
 * languageModelFor), so whatever options that sets are under test too. */
function scriptedEndpoint(scripts: Response[]): {
  baseUrl: string;
  bodies: Array<Record<string, unknown>>;
  close: () => Promise<void>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    bodies.push(await req.json() as Record<string, unknown>);
    return scripts[Math.min(bodies.length - 1, scripts.length - 1)]!;
  });
  // The port is assigned by the listener, which Deno starts with the
  // server: `addr` is readable right away (see browser/client_test.ts).
  const { port } = server.addr as Deno.NetAddr;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => server.shutdown(),
  };
}

/** The read tool's image through the whole path: the model asks for an
 * image file, the tool returns the pixels, and both audiences get them —
 * the transcript (UI, DB, image analysis) and the next request, where the
 * image must arrive as an image and not merely as its text marker. */
Deno.test("a read tool image reaches the model and the transcript", async () => {
  await withTempDir("lumisca-read-image-", async (root) => {
    const imagePath = join(root, "pic.png");
    await Deno.writeFile(imagePath, MINI_PNG);
    const endpoint = scriptedEndpoint([
      toolCallAnswer("t1", "read", { path: imagePath }),
      textAnswer("I can see it."),
    ]);
    try {
      const model: Model<Api> = {
        id: "m",
        name: "m",
        api: "openai-completions",
        provider: "tool-image-e2e",
        baseUrl: endpoint.baseUrl,
        // A vision model: this is the very case that used to lose the image.
        input: ["text", "image"],
      };
      const agent = new Agent({
        initialState: {
          systemPrompt: "test",
          model,
          tools: [
            toAgentTool(
              createReadFileTool({
                files: new HostFileBackend(new Sandbox([root])),
              }),
            ),
          ],
          thinkingLevel: "off",
        },
        streamFn: createStreamFn({
          languageModelFor: () =>
            Promise.resolve(
              languageModelFor(model, { apiKey: "test-key", source: "test" }),
            ),
        }),
        sessionId: "s1",
      });

      await agent.prompt(`read ${imagePath}`);

      // The transcript carries the image: the UI renders it under the tool
      // line, the DB keeps it across a reload, and the image analysis of a
      // text-only model reads it.
      const result = agent.messages.find((m) =>
        m.role === "toolResult"
      ) as ToolResultMessage;
      assertEquals(result.content.map((b) => b.type), ["text", "image"]);
      assertEquals(result.content[1], {
        type: "image",
        data: bytesToBase64(MINI_PNG),
        mimeType: "image/png",
      });

      // The second request hands the picture to the model — inside the tool
      // message itself (the compatible provider is built with multi-part
      // tool content), not as a text marker only.
      assertEquals(endpoint.bodies.length, 2);
      const messages = endpoint.bodies[1]!.messages as Array<
        Record<string, unknown>
      >;
      const toolMessage = messages.find((m) => m.role === "tool")!;
      assertEquals(toolMessage.content, [
        { type: "text", text: expectImageMarker(imagePath) },
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${bytesToBase64(MINI_PNG)}`,
          },
        },
      ]);
    } finally {
      await endpoint.close();
    }
  });
});

/** The read tool's text for a whole-file image read. */
function expectImageMarker(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return `[image: ${name} (${MINI_PNG.byteLength} bytes)]`;
}
