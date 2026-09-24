import { assertEquals } from "@std/assert";
import {
  compactionUsageRatio,
  contextUsageRatio,
  summarizeContextUsage,
} from "./context-usage.ts";
import type { AgentMessage } from "../ai/types.ts";

/** An assistant turn carrying the given provider usage. */
function assistant(input: number, output = 0): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: "p",
    model: "m",
    usage: { input, output, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp: 1,
  } as AgentMessage;
}

Deno.test("contextUsageRatio: the latest turn against the window", () => {
  const summary = summarizeContextUsage([assistant(50_000)]);
  assertEquals(contextUsageRatio(summary, 200_000), 0.25);
  // No usage yet, or no window: nothing to show.
  assertEquals(
    contextUsageRatio(summarizeContextUsage([]), 200_000),
    undefined,
  );
  assertEquals(contextUsageRatio(summary, undefined), undefined);
  assertEquals(contextUsageRatio(summary, 0), undefined);
  // A transcript past the window reports above 1 (the meter clamps it).
  const over = summarizeContextUsage([assistant(300_000)]);
  assertEquals(contextUsageRatio(over, 200_000), 1.5);
});

Deno.test("compactionUsageRatio is the point the next check condenses from", () => {
  // pi's rule: compact at `window - reserveTokens`.
  assertEquals(compactionUsageRatio(200_000, 16_384), 0.91808);
  assertEquals(compactionUsageRatio(4_000, 1_500), 0.625);
  // Unknown window, a reservation that leaves no room, or no reservation:
  // compaction is off, so the meter keeps its own hint.
  assertEquals(compactionUsageRatio(undefined, 16_384), undefined);
  assertEquals(compactionUsageRatio(10_000, 16_384), undefined);
  assertEquals(compactionUsageRatio(10_000, 0), undefined);
  assertEquals(compactionUsageRatio(10_000, -1), undefined);
});
