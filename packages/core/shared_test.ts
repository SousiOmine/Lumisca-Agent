import { assertEquals } from "@std/assert";
import {
  contextTokensOf,
  contextUsageRatio,
  FAST_MODEL_KEY,
  formatCompactTokens,
  formatContextUsageLine,
  formatPercent1,
  IMAGE_MODEL_KEY,
  parseModelPreference,
  serializeModelPreference,
  summarizeContextUsage,
} from "./shared.ts";

Deno.test("model preference keys are distinct settings keys", () => {
  assertEquals(FAST_MODEL_KEY, "model_fast");
  assertEquals(IMAGE_MODEL_KEY, "model_image");
});

Deno.test("serialize/parse round-trips a model preference", () => {
  const pref = { provider: "openai", modelId: "gpt-4o-mini" };
  assertEquals(parseModelPreference(serializeModelPreference(pref)), pref);
});

Deno.test("parseModelPreference returns undefined for unset/empty/malformed", () => {
  assertEquals(parseModelPreference(undefined), undefined);
  assertEquals(parseModelPreference(null), undefined);
  assertEquals(parseModelPreference(""), undefined);
  assertEquals(parseModelPreference("not json"), undefined);
  assertEquals(parseModelPreference("{}"), undefined);
  assertEquals(
    parseModelPreference(JSON.stringify({ provider: "openai" })),
    undefined,
  );
  assertEquals(
    parseModelPreference(JSON.stringify({ provider: "openai", modelId: 42 })),
    undefined,
  );
});

Deno.test("contextTokensOf sums input/cacheRead/cacheWrite", () => {
  assertEquals(
    contextTokensOf({ input: 1000, cacheRead: 2000, cacheWrite: 500 }),
    3500,
  );
  assertEquals(contextTokensOf({ input: 1000 }), 1000);
  assertEquals(contextTokensOf(undefined), 0);
  assertEquals(contextTokensOf(null), 0);
  // Non-finite and negative values never reduce the count.
  assertEquals(
    contextTokensOf({ input: NaN, cacheRead: -50, cacheWrite: Infinity }),
    0,
  );
});

Deno.test("summarizeContextUsage takes the latest turn and averages cache hits", () => {
  const summary = summarizeContextUsage([
    { role: "user" },
    {
      role: "assistant",
      usage: { input: 1000, cacheRead: 9000, cacheWrite: 0 },
    },
    { role: "toolResult" },
    {
      role: "assistant",
      usage: { input: 1200, cacheRead: 300000, cacheWrite: 0 },
    },
  ]);
  assertEquals(summary.turns, 2);
  assertEquals(summary.currentTokens, 301200);
  assertEquals(summary.currentCacheRead, 300000);
  assertEquals(summary.totalTokens, 311200);
  assertEquals(summary.totalCacheRead, 309000);
  assertEquals(
    summary.averageCacheHitRate,
    309000 / 311200,
  );
});

Deno.test("summarizeContextUsage ignores rows without usage", () => {
  const summary = summarizeContextUsage([
    { role: "user" },
    { role: "assistant" },
  ]);
  assertEquals(summary.turns, 0);
  assertEquals(summary.currentTokens, undefined);
  assertEquals(summary.averageCacheHitRate, undefined);
  assertEquals(formatContextUsageLine(summary, 1_000_000), "");
});

Deno.test("contextUsageRatio is undefined without current tokens or window", () => {
  const summary = summarizeContextUsage([
    { role: "assistant", usage: { input: 100 } },
  ]);
  assertEquals(contextUsageRatio(summary, 1000), 0.1);
  assertEquals(contextUsageRatio(summary, undefined), undefined);
  assertEquals(contextUsageRatio(summary, 0), undefined);
  assertEquals(
    contextUsageRatio(summarizeContextUsage([]), 1000),
    undefined,
  );
});

Deno.test("token and percent formatters match the reference card", () => {
  assertEquals(formatCompactTokens(301200), "301.2K");
  assertEquals(formatCompactTokens(1_000_000), "1M");
  assertEquals(formatCompactTokens(12000), "12K");
  assertEquals(formatCompactTokens(42), "42");
  assertEquals(formatPercent1(0.301), "30.1%");
  assertEquals(formatPercent1(0.924), "92.4%");
});

Deno.test("formatContextUsageLine renders the card headline in one line", () => {
  const summary = summarizeContextUsage([
    { role: "assistant", usage: { input: 1200, cacheRead: 300000 } },
  ]);
  assertEquals(
    formatContextUsageLine(summary, 1_000_000),
    "301.2K/1M (30.1%) · Avg cache hit 99.6%",
  );
  assertEquals(
    formatContextUsageLine(summary, undefined),
    "301.2K · Avg cache hit 99.6%",
  );
});
