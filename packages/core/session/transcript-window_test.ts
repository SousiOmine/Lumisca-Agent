import { assert, assertEquals, assertThrows } from "@std/assert";
import { CoreError } from "../errors.ts";
import type { AgentMessage } from "../ai/types.ts";
import {
  identityCursor,
  MAX_TRANSCRIPT_WINDOW_ITEMS,
  messageCursorOf,
  readWindow,
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

/** The window readers below page through: three user turns, each with an
 * assistant answer and, in the middle one, a tool result. */
function transcript(): AgentMessage[] {
  return [
    message("user", 1),
    message("assistant", 2),
    message("user", 3),
    message("assistant", 4),
    message("toolResult", 5),
    message("user", 6),
    message("assistant", 7),
  ];
}

/** Read windows the way a client does: newest first, then the page the
 * returned cursor names. */
function page(
  items: readonly AgentMessage[],
  older: string | null,
  limit: number,
) {
  return readWindow(items, { older, limit }, {
    cursor: messageCursorOf,
    startsWindow: (index) => startsTranscriptTurn(items[index]!.role),
  });
}

Deno.test("readWindow: the newest window starts at a turn", () => {
  const items = transcript();
  const page1 = page(items, null, 2);
  // Two messages back from the end is assistant+toolResult's middle: the
  // window walks back to the prompt that opened the turn.
  assertEquals(page1.items, items.slice(5));
  assertEquals(page1.items[0]!.role, "user");
  // There is history before it, so the way back is a cursor, not null.
  assertEquals(page1.older, messageCursorOf(items[5]!));
});

Deno.test("readWindow: paging back walks the transcript once", () => {
  const items = transcript();
  const seen: number[] = [];
  let older: string | null = null;
  for (let guard = 0; guard < 20; guard++) {
    const window = page(items, older, 2);
    seen.unshift(...window.items.map((m) => m.timestamp));
    older = window.older;
    if (older === null) break;
  }
  assertEquals(seen, items.map((m) => m.timestamp));
});

Deno.test("readWindow: the beginning ends the walk", () => {
  const items = transcript();
  const window = page(items, messageCursorOf(items[2]!), 10);
  assertEquals(window.items, items.slice(0, 2));
  // Nothing is before the first message: no cursor to ask with again.
  assertEquals(window.older, null);
});

Deno.test("readWindow: a window may exceed the page size to keep a turn whole", () => {
  const items = transcript();
  // The last turn is the prompt and its answer, so a page size of 1 still
  // returns both rather than half a turn.
  const window = page(items, null, 1);
  assertEquals(window.items, items.slice(5));
});

Deno.test("readWindow: a window starts at a checkpoint, not inside it", () => {
  const items: AgentMessage[] = [
    message("user", 1),
    message("assistant", 2),
    message("checkpoint", 3),
    message("assistant", 4),
  ];
  // Backing up from the last assistant message reaches the assistant, then
  // the checkpoint: a checkpoint begins a screen unit of its own.
  const window = page(items, null, 1);
  assertEquals(window.items, items.slice(2));
});

Deno.test("readWindow: the cursor is an identity and survives an insertion", () => {
  const items = transcript();
  const first = page(items, null, 2);
  const older = first.older!;
  // Compaction inserts a checkpoint before the message the cursor names: the
  // cursor still finds it (positions moved, identities did not).
  const withCheckpoint = [
    ...items.slice(0, 5),
    message("checkpoint", 55),
    ...items.slice(5),
  ];
  // The window before the user's message now carries the checkpoint too: it
  // is still found by identity, and the row is part of that history.
  const second = page(withCheckpoint, older, 10);
  assertEquals(second.items.map((m) => m.timestamp), [1, 2, 3, 4, 5, 55]);
});

Deno.test("readWindow: a cursor the transcript no longer has conflicts", () => {
  const items = transcript();
  // A rewind removed the message the cursor named: the client's view and the
  // transcript have diverged, and a window it did not ask for would hide it.
  const error = assertThrows(
    () => page(items, messageCursorOf(message("user", 99)), 2),
    CoreError,
  );
  assertEquals(error.kind, "conflict");
});

Deno.test("readWindow: a page size beyond the maximum is clamped", () => {
  const items = Array.from(
    { length: MAX_TRANSCRIPT_WINDOW_ITEMS + 50 },
    (_, index) => message(index % 2 === 0 ? "user" : "assistant", index),
  );
  assertEquals(
    page(items, null, MAX_TRANSCRIPT_WINDOW_ITEMS * 10).items.length,
    MAX_TRANSCRIPT_WINDOW_ITEMS,
  );
});

Deno.test("readWindow: an invalid page size is rejected, not guessed", () => {
  const items = transcript();
  for (const limit of [0, -1, 1.5]) {
    const error = assertThrows(() => page(items, null, limit), CoreError);
    assertEquals(error.kind, "invalid", String(limit));
  }
});

Deno.test("readWindow: an empty transcript has no pages", () => {
  const window = page([], null, 10);
  assertEquals(window.items, []);
  assertEquals(window.older, null);
});

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

Deno.test("identityCursor: the fields are encoded as JSON, opaque to clients", () => {
  assertEquals(
    identityCursor({ role: "user", timestamp: 5 }),
    '["user",5,""]',
  );
  assertEquals(
    identityCursor({ role: "toolResult", timestamp: 5, toolCallId: "c1" }),
    '["toolResult",5,"c1"]',
  );
});
