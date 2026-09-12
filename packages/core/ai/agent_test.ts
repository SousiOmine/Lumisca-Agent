import { assert, assertEquals } from "@std/assert";
import type { AgentMessage, AgentTool, Api, Model, StreamFn } from "./types.ts";
import { Agent } from "./agent.ts";
import { createAssistantMessageEventStream } from "./event-stream.ts";
import { fauxAssistantMessage, fauxToolCall } from "./faux.ts";
import { contentText } from "../shared/mod.ts";

function fakeModel(): Model<Api> {
  return { id: "m", name: "m" } as unknown as Model<Api>;
}

/** One scheduler turn: lets the run reach the stream function. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * A stream function that behaves like the real transport with respect to
 * aborts: a call whose signal is ALREADY aborted fails immediately (the
 * provider never starts a request), and the first response is held until
 * the signal fires — a provider that closes the stream when the client
 * cancels. Later calls answer immediately.
 *
 * The faux provider ignores signals entirely, which is why the shared
 * controller bug (every run after an abort used an aborted signal) stayed
 * invisible in the suite.
 */
function abortAwareStreamFn(answers: string[]): {
  streamFn: StreamFn;
  calls: () => number;
} {
  let calls = 0;
  const streamFn: StreamFn = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    if (options?.signal?.aborted === true) {
      stream.push({
        type: "error",
        errorMessage: "The signal has been aborted",
      });
      stream.end();
      return stream;
    }
    const index = calls++;
    const message = fauxAssistantMessage(answers[index] ?? "answer");
    const finish = () => {
      stream.push({ type: "start", partial: message });
      stream.end(message);
    };
    if (index === 0) {
      options?.signal?.addEventListener("abort", finish, { once: true });
    } else {
      finish();
    }
    return stream;
  };
  return { streamFn, calls: () => calls };
}

function makeAgent(streamFn: StreamFn): Agent {
  return new Agent({
    initialState: {
      systemPrompt: "You are a test agent.",
      model: fakeModel(),
      tools: [],
    },
    streamFn,
    sessionId: "s1",
  });
}

/** Text of an assistant message (empty for other roles/undefined). */
function assistantText(message: AgentMessage | undefined): string {
  if (message === undefined || message.role !== "assistant") return "";
  return contentText(message.content);
}

Deno.test("an abort does not leak into later runs (the signal is per run)", async () => {
  const { streamFn, calls } = abortAwareStreamFn(["held", "second answer"]);
  const agent = makeAgent(streamFn);

  // The first run holds its response until the abort ends it.
  const first = agent.prompt("one");
  await tick();
  assertEquals(calls(), 1);
  agent.abort();
  await first;
  await agent.waitForIdle();
  assertEquals(agent.isStreaming, false);

  // The next run must reach the provider: a reused abort signal would make
  // the transport refuse the call ("The signal has been aborted") and the
  // session would silently never run again.
  await agent.prompt("two");
  assertEquals(calls(), 2);
  assertEquals(assistantText(agent.messages.at(-1)), "second answer");
});

Deno.test("a prompt while a run is aborting starts its own run, not a lost queue entry", async () => {
  const { streamFn, calls } = abortAwareStreamFn(["held", "second answer"]);
  const agent = makeAgent(streamFn);

  const first = agent.prompt("one");
  await tick();
  agent.abort();
  // Sent while the aborted run is still unwinding: a queue entry would be
  // dropped when that run settles (rewind clears the queues), so this must
  // wait for the run to end and then start its own.
  const second = agent.prompt("two");
  await first;
  await second;

  assertEquals(calls(), 2);
  const answers = agent.messages.filter((m) => m.role === "assistant");
  assertEquals(assistantText(answers.at(-1)), "second answer");
});

/** A tool whose execution takes `delayMs`: it keeps the exchange loop busy
 * long enough for a test to steer a message in mid-loop. */
function slowTool(delayMs: number): AgentTool {
  return {
    name: "slow_tool",
    label: "Slow",
    description: "A tool that takes a moment.",
    parameters: {},
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };
}

/** The text of a user message (used to assert the transcript order). */
function userText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      (b as { type?: string; text?: string }).type === "text"
        ? (b as { text: string }).text
        : ""
    )
    .join("");
}

Deno.test("a steer during a tool loop is processed at the next turn boundary, not at the end", async () => {
  // Turn 1 asks for the tool; the tool result keeps the loop going. While
  // the tool runs, a message is steered in. It must be drained as the next
  // turn (before the loop ends), so the second LLM call already sees it.
  let calls = 0;
  const streamFn: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    calls++;
    if (calls === 1) {
      const msg = fauxAssistantMessage([fauxToolCall("slow_tool", {})]);
      stream.push({ type: "start", partial: msg });
      stream.end(msg);
    } else {
      const msg = fauxAssistantMessage("reaction to the interrupt");
      stream.push({ type: "start", partial: msg });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "reaction to the interrupt",
        partial: msg,
      });
      stream.end(msg);
    }
    return stream;
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a test agent.",
      model: fakeModel(),
      tools: [slowTool(30)],
    },
    streamFn,
    sessionId: "s1",
  });

  const run = agent.prompt("go");
  // Wait for the run to start and reach the (blocking) tool execution.
  await new Promise((resolve) => setTimeout(resolve, 5));
  agent.steer({
    role: "user",
    content: [{ type: "text", text: "interrupt" }],
    timestamp: Date.now(),
  });
  await run;

  // Two LLM calls happened: the first requested the tool, the second
  // reacted to the steered message.
  assertEquals(calls, 2);

  // Transcript order proves the steer was drained mid-loop: the steered
  // user message sits before the reaction, not after it.
  const roles = agent.messages.map((m) => m.role);
  assert(
    roles.indexOf("user") > -1 && roles.indexOf("toolResult") > -1,
    `expected a user + toolResult transcript, got ${JSON.stringify(roles)}`,
  );
  const steerIndex = agent.messages.findIndex((m) =>
    m.role === "user" && userText(m) === "interrupt"
  );
  const reactionIndex = agent.messages.findIndex((m) =>
    m.role === "assistant" &&
    contentText(m.content).includes("reaction to the interrupt")
  );
  assert(
    steerIndex !== -1 && reactionIndex !== -1,
    "steer or reaction missing from the transcript",
  );
  assert(
    steerIndex < reactionIndex,
    "the steered message must be processed before the loop moves on",
  );
});
