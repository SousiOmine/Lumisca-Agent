import { assertEquals } from "@std/assert";
import type {
  AgentMessage,
  ImageContent,
  ModeMessage,
  NotificationMessage,
} from "@lumisca/core";
import {
  notificationMessage,
  notificationText,
  toLlmMessages,
} from "./notification.ts";

function notification(
  overrides: Partial<NotificationMessage> = {},
): NotificationMessage {
  return {
    role: "notification",
    kind: "background",
    title: "[Background command #2 finished after 12s (exit code 0)]",
    body: "listening on :3000",
    status: "success",
    timestamp: 1700000000000,
    ...overrides,
  };
}

Deno.test("notificationText joins title and body, omits empty bodies", () => {
  assertEquals(
    notificationText(notification()),
    "[Background command #2 finished after 12s (exit code 0)]\nlistening on :3000",
  );
  assertEquals(
    notificationText(notification({ body: "" })),
    "[Background command #2 finished after 12s (exit code 0)]",
  );
});

Deno.test("toLlmMessages converts notifications to user messages", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "start" }], timestamp: 1 },
    notification(),
    {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "faux",
      provider: "faux",
      model: "faux",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
      stopReason: "stop",
      timestamp: 3,
    },
  ];
  const converted = toLlmMessages(messages);
  assertEquals(converted.length, 3);
  assertEquals(converted[0], messages[0]);
  assertEquals(converted[1], {
    role: "user",
    content: [{
      type: "text",
      text:
        "[Background command #2 finished after 12s (exit code 0)]\nlistening on :3000",
    }],
    timestamp: 1700000000000,
  });
  // The notification keeps its structured fields for the UI/DB; only the
  // LLM sees the reconstructed user text.
  assertEquals((messages[1] as NotificationMessage).kind, "background");
  assertEquals(converted[2], messages[2]);
});

Deno.test("toLlmMessages drops roles the provider cannot see", () => {
  const messages: AgentMessage[] = [
    notification(),
    { role: "somethingElse", timestamp: 9 } as unknown as AgentMessage,
  ];
  const converted = toLlmMessages(messages);
  assertEquals(converted.length, 1);
  assertEquals(converted[0]!.role, "user");
});

Deno.test("toLlmMessages converts mode messages to user messages with the full prompt", () => {
  const modeMsg: ModeMessage = {
    role: "mode",
    modeId: "review",
    optionId: "uncommitted",
    modeLabel: "レビューモード",
    shortText: "未コミットの変更をレビューしてください",
    fullPrompt: "あなたはコードレビュアーです。…(長文)",
    images: [],
    timestamp: 1700000000000,
  };
  const converted = toLlmMessages([modeMsg]);
  assertEquals(converted.length, 1);
  assertEquals(converted[0], {
    role: "user",
    content: [{ type: "text", text: modeMsg.fullPrompt }],
    timestamp: modeMsg.timestamp,
  });
});

Deno.test("toLlmMessages passes the images attached to a mode message", () => {
  // A picture attached in the composer before the mode prompt was sent:
  // the model must receive the same content blocks a plain user message
  // with an image would carry.
  const image: ImageContent = {
    type: "image",
    data: "QUJD",
    mimeType: "image/png",
  };
  const modeMsg: ModeMessage = {
    role: "mode",
    modeId: "plan",
    optionId: "",
    modeLabel: "プラン作成モード",
    shortText: "履歴機能を追加して",
    fullPrompt: "あなたは実装プランナーです。…(長文)",
    images: [image],
    timestamp: 1700000000000,
  };
  const converted = toLlmMessages([modeMsg]);
  assertEquals(converted.length, 1);
  assertEquals(converted[0], {
    role: "user",
    content: [{ type: "text", text: modeMsg.fullPrompt }, image],
    timestamp: modeMsg.timestamp,
  });
});

Deno.test("notificationMessage stamps the payload", () => {
  const before = Date.now();
  const message = notificationMessage({
    kind: "task",
    title: "[Task agent_1 finished]",
    body: "ok",
    status: "success",
  });
  assertEquals(message.role, "notification");
  assertEquals(message.kind, "task");
  assertEquals(message.timestamp >= before, true);
});

Deno.test("toLlmMessages sends modelContent when the prompt has one", () => {
  // A prompt can carry text addressed to the model that the user never wrote
  // (the notice naming attached files). The request gets that text; the
  // conversation keeps drawing `content`, which stays the user's own words.
  const messages: AgentMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "このログを見て" }],
      modelContent:
        "このログを見て\n\n[Attached files]\n- run.log: /vm/run.log",
      timestamp: 1,
    },
  ];
  const out = toLlmMessages(messages);
  assertEquals(out.length, 1);
  assertEquals(
    out[0]!.content,
    "このログを見て\n\n[Attached files]\n- run.log: /vm/run.log",
  );
});

Deno.test("toLlmMessages sends a prompt whose visible text is empty", () => {
  // A prompt that is only files shows nothing on screen but is a real turn:
  // its emptiness is a display fact, not a reason to drop the run.
  const messages: AgentMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "" }],
      modelContent: "[Attached files]\n- run.log: /vm/run.log",
      timestamp: 1,
    },
  ];
  const out = toLlmMessages(messages);
  assertEquals(out.length, 1);
  assertEquals(out[0]!.content, "[Attached files]\n- run.log: /vm/run.log");
});

Deno.test("toLlmMessages: a prompt without modelContent is sent unchanged", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
  ];
  const out = toLlmMessages(messages);
  assertEquals(out[0], messages[0]);
});
