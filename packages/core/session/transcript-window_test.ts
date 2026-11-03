import { assert, assertEquals } from "@std/assert";
import type { AgentMessage } from "../ai/types.ts";
import {
  identityCursor,
  messageCursorOf,
  startsTranscriptTurn,
} from "./transcript-window.ts";

/** One transcript message of a role, stamped with a timestamp. */
function message(
  role: AgentMessage["role"],
  timestamp: number,
): AgentMessage {
  switch (role) {
    case "toolResult":
      return {
        role,
        toolCallId: `t${timestamp}`,
        toolName: "read",
        content: [],
        isError: false,
        timestamp,
      } as AgentMessage;
    case "checkpoint":
      return { role, title: "sum", body: "b", timestamp };
    case "context":
      return { role, provider: "skills", title: "t", body: "b", timestamp };
    case "notification":
      return {
        role,
        kind: "background",
        title: "t",
        body: "",
        status: "neutral",
        timestamp,
      };
    default:
      return { role, content: `#${timestamp}`, timestamp } as AgentMessage;
  }
}

Deno.test("messageCursorOf: parallel tool results are told apart", () => {
  const first = message("toolResult", 10);
  const second = { ...message("toolResult", 10), toolCallId: "other" };
  assert(messageCursorOf(first) !== messageCursorOf(second));
  // The same tool result names the same cursor, which is what a client
  // echoes back.
  assertEquals(
    messageCursorOf(first),
    messageCursorOf(message("toolResult", 10)),
  );
});

Deno.test("messageCursorOf: context snapshots of one millisecond are told apart", () => {
  // The dynamic contexts are published in one loop, so two of them can share
  // a millisecond. Role + timestamp alone would name one message for two
  // rows, and a client merging a window would insert the same row again on
  // every resync (see web's mergeNewestWindow).
  const skills = message("context", 10);
  const date = { ...message("context", 10), provider: "date" };
  assert(messageCursorOf(skills) !== messageCursorOf(date));
  assertEquals(
    messageCursorOf(skills),
    messageCursorOf(message("context", 10)),
  );
});

Deno.test("identityCursor: the fields are encoded as JSON, opaque to clients", () => {
  assertEquals(
    identityCursor({ role: "user", timestamp: 5 }),
    '["user",5,"",""]',
  );
  assertEquals(
    identityCursor({ role: "toolResult", timestamp: 5, toolCallId: "c1" }),
    '["toolResult",5,"c1",""]',
  );
  assertEquals(
    identityCursor({ role: "context", timestamp: 5, provider: "date" }),
    '["context",5,"","date"]',
  );
});

Deno.test("startsTranscriptTurn: a retry notification does not open a turn", () => {
  // The renderer drops a retry (the loop's own repair of an empty or cut-off
  // response) instead of drawing a row for it. A window that BEGAN on one
  // therefore began on a row the client never draws — and a window with no
  // turn to show renders as an empty screen, which is exactly the report this
  // covers.
  const retry = {
    ...message("notification", 1),
    kind: "retry",
  } as AgentMessage;
  assertEquals(startsTranscriptTurn(retry), false);
  // Every other notification did start a run of its own, so it opens one.
  assertEquals(startsTranscriptTurn(message("notification", 2)), true);
});

Deno.test("startsTranscriptTurn: prompts, modes and checkpoints open a turn", () => {
  assertEquals(startsTranscriptTurn(message("user", 1)), true);
  assertEquals(startsTranscriptTurn(message("mode", 2)), true);
  assertEquals(startsTranscriptTurn(message("checkpoint", 3)), true);
  // Everything else belongs to the turn before it.
  assertEquals(startsTranscriptTurn(message("assistant", 4)), false);
  assertEquals(startsTranscriptTurn(message("toolResult", 5)), false);
  assertEquals(startsTranscriptTurn(message("context", 6)), false);
});
