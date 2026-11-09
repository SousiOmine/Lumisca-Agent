import { assert, assertEquals } from "@std/assert";
import type { AgentMessage } from "../../types.ts";
import { MessageRow } from "./MessageRow.tsx";

/** A prompt a routine started, shaped as the server stores it. */
function routinePrompt(): AgentMessage {
  return {
    role: "user",
    content: "毎朝の確認をして",
    routine: "毎朝の確認",
    timestamp: 5,
  };
}

Deno.test("MessageRow: a routine's prompt is not drawn", () => {
  // The text is the routine's standing instruction, not something the user
  // typed, so the transcript draws only what the run answered. The message
  // still reaches the row (a turn is grouped by it) — the row has to drop it.
  const row = MessageRow({
    message: routinePrompt(),
    toolResults: new Map(),
    runningTools: new Map(),
    visualBase: "/visual",
  });
  assertEquals(row, null);
});

Deno.test("MessageRow: the same words typed are drawn", () => {
  // The guard must key on the routine stamp, not on the role: hiding every
  // user message would erase the conversation.
  const typed: AgentMessage = {
    role: "user",
    content: "毎朝の確認をして",
    timestamp: 5,
  };
  const row = MessageRow({
    message: typed,
    toolResults: new Map(),
    runningTools: new Map(),
    visualBase: "/visual",
  });
  assert(row !== null);
});
