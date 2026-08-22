import { assert, assertEquals } from "@std/assert";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Model,
  TextContent,
} from "@earendil-works/pi-ai";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { AskHub } from "../tools/ask.ts";
import { object, type Tool } from "../tools/schema.ts";
import type { ClientEvent } from "../types/event.ts";
import type { NotificationMessage } from "../types/notification.ts";
import {
  buildRetryNotification,
  isSilentErrorResponse,
  isVacantResponse,
  MAX_EMPTY_RESPONSE_RETRIES,
  SessionAgent,
} from "./session-agent.ts";

/** A tool that succeeds immediately; a tool call keeps the loop going, so
 * a vacant response after a tool call exercises the counter reset. */
const mockTool: Tool = {
  name: "mock_tool",
  label: "Mock",
  description: "Mock tool for tests.",
  parameters: object({}),
  execute: () =>
    Promise.resolve({
      content: [{ type: "text", text: "ok" }],
      details: {},
    }),
};

/** A stream function that serves the given responses, one per LLM call. */
function streamSequence(responses: AssistantMessage[]): StreamFn {
  let index = 0;
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = responses[index++]!;
    stream.push({ type: "start", partial: message });
    stream.end(message);
    return stream;
  };
}

function makeAgent(streamFn: StreamFn, tools: Tool[] = []): SessionAgent {
  return new SessionAgent({
    sessionId: "s1",
    systemPrompt: "You are a test agent.",
    model: { id: "test", name: "test" } as unknown as Model<Api>,
    tools,
    streamFn,
    messageRepo: {
      append: (_sessionId, message) => ({
        id: "id",
        sessionId: _sessionId,
        role: message.role,
        message,
        timestamp: message.timestamp,
      }),
      list: () => [],
      listMessages: () => [],
      deleteFrom: () => {},
      deleteBySession: () => {},
    },
    onEvent: (_event: ClientEvent) => {},
    askHub: new AskHub("s1", () => {}),
    renameSession: () => {},
  });
}

/** The retry notifications queued into the transcript (kind "retry"). */
function retryNotifications(
  messages: AgentMessage[],
): NotificationMessage[] {
  return messages.filter(
    (m): m is NotificationMessage =>
      m.role === "notification" && m.kind === "retry",
  );
}

Deno.test("isVacantResponse: vacant when there is no text and no tool call", () => {
  assertEquals(isVacantResponse(fauxAssistantMessage("")), true);
  assertEquals(
    isVacantResponse(fauxAssistantMessage([fauxThinking("...")])),
    true,
  );
});

Deno.test("isVacantResponse: not vacant with text or tool calls", () => {
  assertEquals(isVacantResponse(fauxAssistantMessage("Hello")), false);
  assertEquals(
    isVacantResponse(
      fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })]),
    ),
    false,
  );
  // Thinking alone is vacant, but any text alongside it is output.
  assertEquals(
    isVacantResponse(
      fauxAssistantMessage([fauxThinking("..."), fauxText("Hi")]),
    ),
    false,
  );
});

Deno.test("isVacantResponse: error/aborted stops are never retried", () => {
  assertEquals(
    isVacantResponse(fauxAssistantMessage("", { stopReason: "error" })),
    false,
  );
  assertEquals(
    isVacantResponse(fauxAssistantMessage("", { stopReason: "aborted" })),
    false,
  );
});

/** The stream-disconnection turn observed with deepseek-v4-flash via
 * opencode-go: thinking streamed, then the stream ended without a
 * finish_reason. */
function fauxSilentError(): AssistantMessage {
  return fauxAssistantMessage([fauxThinking("...")], {
    stopReason: "error",
    errorMessage: "Stream ended without finish_reason",
  });
}

Deno.test("isSilentErrorResponse: transient outputless errors qualify", () => {
  assertEquals(isSilentErrorResponse(fauxSilentError()), true);
  assertEquals(
    isSilentErrorResponse(
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "fetch failed",
      }),
    ),
    true,
  );
});

Deno.test("isSilentErrorResponse: output, non-errors and permanent failures do not", () => {
  assertEquals(isSilentErrorResponse(fauxAssistantMessage("Hello")), false);
  // Vacant but a normal stop: handled by the in-run retry, not this one.
  assertEquals(isSilentErrorResponse(fauxAssistantMessage("")), false);
  assertEquals(
    isSilentErrorResponse(
      fauxAssistantMessage([fauxText("partial")], {
        stopReason: "error",
        errorMessage: "connection reset",
      }),
    ),
    false,
  );
  assertEquals(
    isSilentErrorResponse(fauxAssistantMessage("", { stopReason: "aborted" })),
    false,
  );
  // Permanent failures must surface immediately instead of being retried.
  assertEquals(
    isSilentErrorResponse(
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Provider is not configured: amazon-bedrock",
      }),
    ),
    false,
  );
  assertEquals(
    isSilentErrorResponse(
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
    ),
    false,
  );
});

Deno.test("buildRetryNotification: self-contained continue instruction", () => {
  const notification = buildRetryNotification(2);
  assertEquals(notification.role, "notification");
  assertEquals(notification.kind, "retry");
  assertEquals(notification.status, "neutral");
  assert(notification.title.includes("2"), "title carries the attempt number");
  assert(
    notification.body.includes("Continue"),
    "body tells the model to continue",
  );
});

Deno.test("a vacant response is retried within the same run", async () => {
  const agent = makeAgent(streamSequence([
    fauxAssistantMessage(""),
    fauxAssistantMessage("Here is the answer."),
  ]));
  await agent.prompt("hello");

  const messages = agent.messages;
  assertEquals(messages[0]?.role, "user");
  assertEquals(retryNotifications(messages).length, 1);
  // The final message is the retried response, after the retry notification.
  const last = messages.at(-1) as AssistantMessage;
  assertEquals(last.role, "assistant");
  assertEquals((last.content[0] as TextContent).text, "Here is the answer.");
});

Deno.test("consecutive vacant responses stop retrying after the limit", async () => {
  const agent = makeAgent(streamSequence(
    Array.from(
      { length: MAX_EMPTY_RESPONSE_RETRIES + 1 },
      () => fauxAssistantMessage(""),
    ),
  ));
  await agent.prompt("hello");

  const messages = agent.messages;
  // Every vacant response up to the limit is retried; the run then ends
  // normally with the final vacant response still in the transcript.
  assertEquals(retryNotifications(messages).length, MAX_EMPTY_RESPONSE_RETRIES);
  assertEquals(messages.at(-1)?.role, "assistant");
});

Deno.test("a tool call resets the retry counter within a run", async () => {
  // vacant → retry → tool call (resets the counter) → vacant → retry →
  // vacant → retry → vacant → retry → vacant (stop): four retries total.
  // Without the reset the tool call would not reset, and the counter would
  // hit the limit one response earlier (three retries total).
  const agent = makeAgent(
    streamSequence([
      fauxAssistantMessage(""),
      fauxAssistantMessage([fauxToolCall("mock_tool", {})]),
      fauxAssistantMessage(""),
      fauxAssistantMessage(""),
      fauxAssistantMessage(""),
      fauxAssistantMessage(""),
      fauxAssistantMessage("done"),
    ]),
    [mockTool],
  );
  await agent.prompt("hello");

  assertEquals(retryNotifications(agent.messages).length, 4);
});

Deno.test("the retry counter resets between runs", async () => {
  // The first run burns through the retry limit; a new prompt starts a
  // fresh run, so its vacant response is retried again.
  const agent = makeAgent(streamSequence([
    fauxAssistantMessage(""),
    fauxAssistantMessage(""),
    fauxAssistantMessage(""),
    fauxAssistantMessage(""),
    fauxAssistantMessage(""),
    fauxAssistantMessage("done"),
  ]));
  await agent.prompt("hello");
  await agent.prompt("hello again");

  assertEquals(retryNotifications(agent.messages).length, 4);
  assertEquals(agent.messages.at(-1)?.role, "assistant");
});

Deno.test("a silent stream error restarts the run and recovers", async () => {
  const agent = makeAgent(
    streamSequence([fauxSilentError(), fauxAssistantMessage("Recovered.")]),
  );
  await agent.prompt("hello");

  const messages = agent.messages;
  // user, failed silent-error turn, retry notification, recovered turn.
  assertEquals(retryNotifications(messages).length, 1);
  assertEquals(messages.length, 4);
  const last = messages.at(-1) as AssistantMessage;
  assertEquals((last.content[0] as TextContent).text, "Recovered.");
});

Deno.test("silent stream errors stop restarting after the limit", async () => {
  const agent = makeAgent(streamSequence([
    fauxSilentError(),
    fauxSilentError(),
    fauxSilentError(),
    fauxSilentError(),
  ]));
  await agent.prompt("hello");

  // Three restarts (the limit), then the fourth silent error ends the
  // exchange for good.
  assertEquals(
    retryNotifications(agent.messages).length,
    MAX_EMPTY_RESPONSE_RETRIES,
  );
  assertEquals(agent.messages.at(-1)?.role, "assistant");
});

Deno.test("the retry budget spans in-run vacancies and silent errors", async () => {
  // error → vacant → error → vacant: four outputless turns share one
  // budget; only the first three are retried.
  const agent = makeAgent(streamSequence([
    fauxSilentError(),
    fauxAssistantMessage(""),
    fauxSilentError(),
    fauxAssistantMessage(""),
  ]));
  await agent.prompt("hello");

  assertEquals(
    retryNotifications(agent.messages).length,
    MAX_EMPTY_RESPONSE_RETRIES,
  );
  assertEquals(agent.messages.at(-1)?.role, "assistant");
});

Deno.test("an aborted silent turn is never retried", async () => {
  const agent = makeAgent(streamSequence([
    fauxAssistantMessage("", { stopReason: "aborted" }),
    fauxAssistantMessage("should never be produced"),
  ]));
  await agent.prompt("hello");

  const last = agent.messages.at(-1) as AssistantMessage;
  assertEquals(last.stopReason, "aborted");
});

Deno.test("a new user prompt resets the silent-error retry count", async () => {
  // First prompt burns through the limit; the second prompt starts a
  // fresh exchange and gets its own retries.
  const agent = makeAgent(streamSequence([
    fauxSilentError(),
    fauxSilentError(),
    fauxSilentError(),
    fauxSilentError(),
    fauxSilentError(),
    fauxAssistantMessage("Recovered on the third attempt."),
  ]));
  await agent.prompt("hello");
  await agent.prompt("hello again");

  // First exchange: user + 4 silent errors + 3 retries. Second: user +
  // 1 silent error + 1 retry + recovered answer.
  const messages = agent.messages;
  assertEquals(messages.length, 12);
  const last = messages.at(-1) as AssistantMessage;
  assertEquals(
    (last.content[0] as TextContent).text,
    "Recovered on the third attempt.",
  );
});

Deno.test("an error turn with visible output is not restarted", async () => {
  const agent = makeAgent(streamSequence([
    fauxAssistantMessage([fauxText("partial answer")], {
      stopReason: "error",
      errorMessage: "connection reset",
    }),
    fauxAssistantMessage("never produced"),
  ]));
  await agent.prompt("hello");

  assertEquals(retryNotifications(agent.messages).length, 0);
  const last = agent.messages.at(-1) as AssistantMessage;
  assertEquals(last.stopReason, "error");
});

Deno.test("a permanent silent error is not restarted", async () => {
  const agent = makeAgent(streamSequence([
    fauxAssistantMessage([fauxThinking("...")], {
      stopReason: "error",
      errorMessage: "Provider is not configured: amazon-bedrock",
    }),
    fauxAssistantMessage("never produced"),
  ]));
  await agent.prompt("hello");

  // The unconfigured provider surfaces immediately: one failed turn, no
  // retry notifications.
  assertEquals(retryNotifications(agent.messages).length, 0);
  assertEquals(agent.messages.length, 2);
});
