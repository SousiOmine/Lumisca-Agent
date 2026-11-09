import { assert, assertEquals } from "@std/assert";
import { fauxAssistantMessage } from "../ai/faux.ts";
import type { AgentMessage } from "../ai/types.ts";
import { MAX_REPLY_CHARS, RunReply } from "./run-reply.ts";
import { NO_RESPONSE } from "./silent-reply.ts";

function assistant(
  text: string,
  options: { stopReason?: "stop" | "toolUse"; timestamp?: number } = {},
): AgentMessage {
  return fauxAssistantMessage(text, {
    ...(options.stopReason === undefined
      ? {}
      : { stopReason: options.stopReason }),
    timestamp: options.timestamp ?? 1,
  }) as AgentMessage;
}

/** A `send_chat` result whose `details` carry the sent message (the shape
 * tools/send-chat.ts writes; see shared/chat-message.ts). */
function sent(
  text: string,
  options: { card?: string; timestamp?: number } = {},
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "send_chat",
    content: [{ type: "text", text: "Sent the message to the user." }],
    details: { text, card: options.card ?? null },
    isError: false,
    timestamp: options.timestamp ?? 2,
  } as AgentMessage;
}

Deno.test("RunReply: the run's answer is what the notification carries", () => {
  const reply = new RunReply();
  reply.observe(assistant("直しました。"));
  assertEquals(reply.gist(), "直しました。");
});

Deno.test("RunReply: a silent run carries no reply", () => {
  // The sentinel is how an agent says nothing on purpose (silent-reply.ts):
  // a notification must not print it as if it were an answer.
  const reply = new RunReply();
  reply.observe(assistant(NO_RESPONSE));
  assertEquals(reply.gist(), undefined);
});

Deno.test("RunReply: the narration before a tool call is not the reply", () => {
  // A run that works through ten tools writes ten of these; the user's
  // answer is the turn that did not end in a tool call.
  const reply = new RunReply();
  reply.observe(assistant("ファイルを確認します", { stopReason: "toolUse" }));
  assertEquals(reply.gist(), undefined);
  reply.observe(assistant("テストも回します", { stopReason: "toolUse" }));
  assertEquals(reply.gist(), undefined);
  reply.observe(assistant("3 件直しました。"));
  assertEquals(reply.gist(), "3 件直しました。");
});

Deno.test("RunReply: what send_chat sent is a reply", () => {
  // In stella the answer may arrive only through the tool: the assistant's
  // final text is then the sentinel, and the words are in the result.
  const reply = new RunReply();
  reply.observe(assistant("送ります", { stopReason: "toolUse" }));
  reply.observe(sent("デプロイは緑です。"));
  reply.observe(assistant(NO_RESPONSE));
  assertEquals(reply.gist(), "デプロイは緑です。");
});

Deno.test("RunReply: a message that only carried a card or files is no reply", () => {
  // The conversation shows an empty bubble's worth of words: there is
  // nothing a one-line notification can say.
  const reply = new RunReply();
  reply.observe(sent("", { card: "<Text>x</Text>" }));
  assertEquals(reply.gist(), undefined);
});

Deno.test("RunReply: reset forgets what the previous run said", () => {
  const reply = new RunReply();
  reply.observe(assistant("前の返信"));
  reply.reset();
  assertEquals(reply.gist(), undefined);
});

Deno.test("RunReply: the gist is capped and says so by its length", () => {
  const reply = new RunReply();
  reply.observe(assistant("あ".repeat(MAX_REPLY_CHARS + 50)));
  const gist = reply.gist();
  assert(gist !== undefined);
  assertEquals(Array.from(gist).length, MAX_REPLY_CHARS);
  // A surrogate pair is one character, not half of one: the cap counts
  // characters the reader sees.
  const emoji = new RunReply();
  emoji.observe(assistant("🙂".repeat(MAX_REPLY_CHARS + 1)));
  assertEquals(Array.from(emoji.gist() ?? "").length, MAX_REPLY_CHARS);
});
