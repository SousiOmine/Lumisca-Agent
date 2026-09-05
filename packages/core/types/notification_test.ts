import { assertEquals } from "@std/assert";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type NotificationMessage,
  notificationText,
  toLlmMessages,
} from "./notification.ts";
import type { ModeMessage } from "./mode-message.ts";

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
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
