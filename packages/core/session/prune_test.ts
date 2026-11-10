import { assertEquals } from "@std/assert";
import type {
  AgentMessage,
  AssistantMessage,
  ContextMessage,
  NotificationMessage,
  ToolResultMessage,
} from "../ai/types.ts";
import {
  isPruned,
  PRUNED_CONTEXT,
  PRUNED_TOOL_CALL,
  PRUNED_TOOL_RESULT,
  reduceMessage,
} from "./prune.ts";

function assistant(
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "faux",
    model: "model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp: 1,
  };
}

function toolResult(over: Partial<ToolResultMessage> = {}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "bash",
    content: [{ type: "text", text: "a lot of output" }],
    isError: false,
    timestamp: 2,
    ...over,
  };
}

Deno.test("prune: the conversation's own messages are kept whole", () => {
  const user: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: 1,
  };
  assertEquals(reduceMessage(user).changed, false);
  assertEquals(reduceMessage(user).message, user);

  const checkpoint: AgentMessage = {
    role: "checkpoint",
    title: "t",
    body: "## Goal\n…",
    timestamp: 3,
  };
  assertEquals(reduceMessage(checkpoint).changed, false);
  assertEquals(reduceMessage(checkpoint).message, checkpoint);

  const mode: AgentMessage = {
    role: "mode",
    modeId: "plan",
    optionId: "o",
    modeLabel: "Plan",
    shortText: "plan this",
    fullPrompt: "Please plan this.",
    images: [],
    timestamp: 4,
  };
  assertEquals(reduceMessage(mode).changed, false);
});

Deno.test("prune: a tool call is dropped and marked, its text survives", () => {
  const message = assistant([
    { type: "text", text: "Writing the file now." },
    {
      type: "toolCall",
      id: "call-1",
      name: "write",
      arguments: { path: "big.txt", content: "x".repeat(50_000) },
    },
  ]);
  const { message: reduced, changed } = reduceMessage(message);
  assertEquals(changed, true);
  const blocks = (reduced as AssistantMessage).content;
  assertEquals(
    blocks.some((block) => block.type === "toolCall"),
    false,
    "the call (and its arguments) is gone",
  );
  assertEquals(
    blocks.some((block) =>
      block.type === "text" && block.text === "Writing the file now."
    ),
    true,
    "the agent's words are still there",
  );
  assertEquals(
    blocks.some((block) =>
      block.type === "text" && block.text === PRUNED_TOOL_CALL
    ),
    true,
    "the turn says a call happened",
  );
  // Nothing of the arguments survives anywhere in the row.
  assertEquals(JSON.stringify(reduced).includes("big.txt"), false);
});

Deno.test("prune: thinking is emptied, not removed", () => {
  // A model that requires reasoning_content replayed refuses a history
  // without it; an empty block satisfies the shape at no token cost.
  const message = assistant([
    { type: "thinking", thinking: "a long chain of thought" },
    { type: "text", text: "Answer." },
  ]);
  const { message: reduced, changed } = reduceMessage(message);
  assertEquals(changed, true);
  const thinking = (reduced as AssistantMessage).content.find((block) =>
    block.type === "thinking"
  );
  assertEquals(thinking, { type: "thinking", thinking: "" });
});

Deno.test("prune: a tool result becomes a marker, its details dropped", () => {
  const message = toolResult({
    content: [
      { type: "text", text: "lots of log" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
    details: { stdout: "lots of log" },
  });
  const { message: reduced, changed } = reduceMessage(message);
  assertEquals(changed, true);
  const result = reduced as ToolResultMessage;
  assertEquals(result.content, [{ type: "text", text: PRUNED_TOOL_RESULT }]);
  assertEquals(result.details, undefined);
  // The identity providers match calls by survives: a rewind can put the row
  // back in front of the model and the pair must still line up.
  assertEquals(result.toolCallId, "c1");
  assertEquals(result.toolName, "bash");
  assertEquals(result.isError, false);
});

Deno.test("prune: what the agent sent is part of the conversation", () => {
  const message = toolResult({
    toolName: "send_chat",
    content: [{ type: "text", text: "Sent the message to the user." }],
    details: {
      text: "report.pdf を添付しました。",
      attachments: [{
        name: "0123456789ab.pdf",
        displayName: "report.pdf",
        size: 1,
        inline: false,
      }],
    },
  });
  // The words, the card and the files ARE the conversation: a reload redraws
  // the message from this row, and `history_search` reads it back once the
  // checkpoint has replaced the call that carried the same text.
  assertEquals(reduceMessage(message).changed, false);
  assertEquals(reduceMessage(message).message, message);
});

Deno.test("prune: context publications and notifications become markers", () => {
  const context: ContextMessage = {
    role: "context",
    provider: "skills",
    title: "Skills (3 available)",
    body: "<available_skills>…</available_skills>",
    state: { text: "- a: b" },
    timestamp: 5,
  };
  const reducedContext = reduceMessage(context).message as ContextMessage;
  assertEquals(reducedContext.body, PRUNED_CONTEXT);
  assertEquals(reducedContext.state, undefined);
  assertEquals(reducedContext.title, "Skills (3 available)");

  const notification: NotificationMessage = {
    role: "notification",
    kind: "background",
    title: "[Background command #2 finished]",
    body: "a long output tail",
    status: "neutral",
    timestamp: 6,
  };
  const reducedNotification = reduceMessage(notification)
    .message as NotificationMessage;
  assertEquals(reducedNotification.body, PRUNED_CONTEXT);
  assertEquals(reducedNotification.title, "[Background command #2 finished]");
});

Deno.test("prune: reducing twice changes nothing the second time", () => {
  const messages: AgentMessage[] = [
    assistant([
      { type: "thinking", thinking: "hmm" },
      { type: "toolCall", id: "c1", name: "read", arguments: {} },
    ]),
    toolResult(),
    {
      role: "context",
      provider: "date",
      title: "Date: 2026-11-02",
      body: "The current date is 2026-11-02.",
      timestamp: 7,
    },
  ];
  for (const message of messages) {
    const once = reduceMessage(message);
    assertEquals(once.changed, true);
    assertEquals(isPruned(once.message), true);
    const twice = reduceMessage(once.message);
    assertEquals(twice.changed, false, "already reduced");
    assertEquals(twice.message, once.message);
  }
});
