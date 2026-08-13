import { assertEquals } from "@std/assert";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentMessage,
  NotificationKind,
  NotificationMessage,
} from "../../types.ts";
import { buildTurns } from "./ConversationTurn.tsx";

function user(timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text: "hi" }], timestamp };
}

function notification(
  kind: NotificationKind,
  timestamp: number,
): NotificationMessage {
  return {
    role: "notification",
    kind,
    title: `[${kind}]`,
    body: "",
    status: "neutral",
    timestamp,
  };
}

function assistant(timestamp: number, text = "hi"): AgentMessage {
  return fauxAssistantMessage(text, { timestamp }) as AgentMessage;
}

Deno.test("buildTurns: user prompts and notifications start a turn", () => {
  const turns = buildTurns([
    user(1),
    assistant(2),
    notification("background", 3),
    assistant(4),
  ]);
  assertEquals(turns.length, 2);
  assertEquals(turns[0]!.responses.length, 1);
  assertEquals(turns[1]!.responses.length, 1);
});

Deno.test("buildTurns: retry notifications do not split the turn", () => {
  const turns = buildTurns([
    user(1),
    assistant(2),
    notification("retry", 3),
    assistant(4, "the retried response"),
  ]);
  // One turn: the retry notification neither starts a new turn nor lands
  // in the responses — the retried response joins the same turn.
  assertEquals(turns.length, 1);
  assertEquals(turns[0]!.user.role, "user");
  const responses = turns[0]!.responses;
  assertEquals(responses.length, 2);
  assertEquals(responses.every((m) => m.role === "assistant"), true);
});

Deno.test("buildTurns: retry notifications are skipped entirely", () => {
  const turns = buildTurns([
    user(1),
    assistant(2),
    notification("retry", 3),
  ]);
  assertEquals(turns.length, 1);
  assertEquals(turns[0]!.responses.length, 1);
});
