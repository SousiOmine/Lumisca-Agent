import { assertEquals } from "@std/assert";
import type { AgentMessage, ToolResultMessage } from "../types.ts";
import { deliverablesOf } from "./DeliverablesPanel.tsx";

/** Helper: build a minimal user message. */
function user(timestamp: number): AgentMessage {
  return { role: "user", content: "go", timestamp };
}

/** Helper: build a tool-result message for the present tool. */
function presentResult(
  timestamp: number,
  files: Array<{ path: string; description?: string }>,
  isError = false,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `tc-${timestamp}`,
    toolName: "present",
    content: [{ type: "text", text: "ok" }],
    details: { files },
    isError,
    timestamp,
  } satisfies ToolResultMessage;
}

/** Helper: build a non-present tool-result message. */
function otherResult(timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `tc-${timestamp}`,
    toolName: "read",
    content: [{ type: "text", text: "file contents" }],
    details: {},
    isError: false,
    timestamp,
  } satisfies ToolResultMessage;
}

Deno.test("deliverablesOf: empty messages → empty array", () => {
  assertEquals(deliverablesOf([]), []);
});

Deno.test("deliverablesOf: ignores non-toolResult messages", () => {
  assertEquals(deliverablesOf([user(1)]), []);
});

Deno.test("deliverablesOf: ignores non-present tool results", () => {
  assertEquals(deliverablesOf([otherResult(1)]), []);
});

Deno.test("deliverablesOf: ignores error tool results", () => {
  assertEquals(
    deliverablesOf([presentResult(1, [{ path: "out.txt" }], true)]),
    [],
  );
});

Deno.test("deliverablesOf: extracts files from a single present call", () => {
  const result = deliverablesOf([
    presentResult(1, [
      { path: "a.md", description: "readme" },
      { path: "b.txt" },
    ]),
  ]);
  assertEquals(result.length, 2);
  assertEquals(result[0], { path: "a.md", description: "readme" });
  assertEquals(result[1], { path: "b.txt", description: undefined });
});

Deno.test("deliverablesOf: deduplicates by path, keeps latest description", () => {
  const result = deliverablesOf([
    presentResult(1, [{ path: "a.md", description: "first" }]),
    presentResult(2, [{ path: "a.md", description: "second" }]),
  ]);
  assertEquals(result.length, 1);
  assertEquals(result[0], { path: "a.md", description: "second" });
});

Deno.test("deliverablesOf: preserves order of first appearance", () => {
  const result = deliverablesOf([
    presentResult(1, [{ path: "z.txt" }, { path: "a.txt" }]),
    presentResult(2, [{ path: "m.txt" }]),
  ]);
  assertEquals(result.map((f) => f.path), ["z.txt", "a.txt", "m.txt"]);
});

Deno.test("deliverablesOf: handles missing details gracefully", () => {
  const msg = {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: "present",
    content: [],
    isError: false,
    timestamp: 1,
  } as unknown as AgentMessage;
  assertEquals(deliverablesOf([msg]), []);
});

Deno.test("deliverablesOf: handles details with non-array files", () => {
  const msg = {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: "present",
    content: [],
    details: { files: "not-an-array" },
    isError: false,
    timestamp: 1,
  } as unknown as AgentMessage;
  assertEquals(deliverablesOf([msg]), []);
});

Deno.test("deliverablesOf: skips entries with missing path", () => {
  const result = deliverablesOf([
    presentResult(1, [
      { path: "ok.txt" },
      {} as unknown as { path: string },
    ]),
  ]);
  assertEquals(result.length, 1);
  assertEquals(result[0]!.path, "ok.txt");
});

Deno.test("deliverablesOf: mixed messages extract only present results", () => {
  const result = deliverablesOf([
    user(1),
    otherResult(2),
    presentResult(3, [{ path: "out.md" }]),
    otherResult(4),
  ]);
  assertEquals(result.length, 1);
  assertEquals(result[0]!.path, "out.md");
});
