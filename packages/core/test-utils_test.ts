import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  assistantMessage,
  clientEvent,
  sessionInfo,
  stellaAgent,
  stellaAgentSummary,
  storedMessage,
} from "./test-utils.ts";

test("sessionInfo fills every required field and keeps overrides", () => {
  const plain = sessionInfo();
  assertEquals(typeof plain.mainAgentId, "string");
  assertEquals(plain.workspaceId, "workspace-1");
  assertEquals(sessionInfo({ id: "other" }).id, "other");
});

test("stellaAgent and its summary carry the read-only fields", () => {
  assertEquals(stellaAgent().disabledAt, null);
  assertEquals(stellaAgent({ disabledAt: 5 }).disabledAt, 5);
  assertEquals(stellaAgentSummary({ disabledAt: 5 }).disabledAt, 5);
});

test("assistantMessage is a complete assistant turn", () => {
  const message = assistantMessage();
  assertEquals(message.role, "assistant");
  assertEquals(message.stopReason, "stop");
  assertEquals(message.usage.input, 1);
  assertEquals(assistantMessage({ stopReason: "error" }).stopReason, "error");
});

test("storedMessage and clientEvent are shaped like the wire types", () => {
  const stored = storedMessage();
  assertEquals(stored.agentId, "agent-1");
  assertEquals(stored.message.role, "user");
  const event = clientEvent({ sessionId: "s2" });
  assertEquals(event.type, "agent_start");
  assertEquals(event.sessionId, "s2");
});
