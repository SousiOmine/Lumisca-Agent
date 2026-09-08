import { assert, assertEquals } from "@std/assert";
import type { AgentMessage, AgentTool, Api, Model, StreamFn } from "./types.ts";
import { Agent } from "./agent.ts";
import { createAssistantMessageEventStream } from "./event-stream.ts";
import { fauxAssistantMessage, fauxToolCall } from "./faux.ts";
import { contentText } from "../shared/mod.ts";

function fakeModel(): Model<Api> {
  return { id: "m", name: "m" } as unknown as Model<Api>;
}

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
