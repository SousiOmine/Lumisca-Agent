import { assertEquals } from "@std/assert";
import {
  contextTokensOf,
  contextUsageRatio,
  estimateMessagesTokens,
  estimateMessageTokens,
  estimateTextTokens,
  estimateToolTokens,
  FAST_MODEL_KEY,
  formatCompactTokens,
  formatContextUsageLine,
  formatPercent1,
  IMAGE_MODEL_KEY,
  IMAGE_TOKEN_ESTIMATE,
  parseModelPreference,
  serializeModelPreference,
  summarizeContextUsage,
} from "./shared/mod.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "./ai/faux.ts";
import type { AgentMessage } from "./ai/types.ts";

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

Deno.test("contextTokensOf sums the prompt's uncached and cached parts", () => {
  assertEquals(
    contextTokensOf({ input: 1000, cacheRead: 2000, cacheWrite: 500 }),
    3500,
  );
  assertEquals(contextTokensOf({ input: 1000 }), 1000);
  assertEquals(contextTokensOf({ cacheRead: 1000 }), 1000);
  assertEquals(contextTokensOf({ input: 0 }), 0);
  assertEquals(contextTokensOf({}), 0);
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

Deno.test("summarizeContextUsage skips turns that reported no tokens", () => {
  // The placeholder an aborted/failed call leaves behind reports zeros:
  // it carries no context, so it must not reset the meter to 0.
  const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const summary = summarizeContextUsage([
    { role: "assistant", usage: { input: 1200, cacheRead: 300000 } },
    { role: "assistant", usage: empty },
  ]);
  assertEquals(summary.turns, 1);
  assertEquals(summary.currentTokens, 301200);
  assertEquals(summary.currentCacheRead, 300000);
  assertEquals(
    formatContextUsageLine(summary, 1_000_000),
    "301.2K/1M (30.1%) · Avg cache hit 99.6%",
  );
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

// ---- token estimation (see token-estimate.ts) ------------------------------

Deno.test("estimateTextTokens: ASCII is four characters per token", () => {
  assertEquals(estimateTextTokens(""), 0);
  assertEquals(estimateTextTokens("abcd"), 1);
  assertEquals(estimateTextTokens("abcde"), 2);
});

Deno.test("estimateTextTokens: non-ASCII costs one token per character", () => {
  // Japanese is what the four-characters-per-token rule underprices; the
  // estimate must not understate it (compacting late is what overflows).
  assertEquals(estimateTextTokens("日本語"), 3);
  assertEquals(estimateTextTokens("こんにちは世界"), 7);
  // A mixed string sums the two rates.
  assertEquals(estimateTextTokens("abc日"), 1 + 1);
});

Deno.test("estimateMessageTokens prices each role as the model receives it", () => {
  const user: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "abcd" }],
    timestamp: 1,
  };
  const notification: AgentMessage = {
    role: "notification",
    kind: "task",
    title: "abcd",
    body: "abcd",
    status: "success",
    timestamp: 2,
  };
  const context: AgentMessage = {
    role: "context",
    provider: "skills",
    title: "Skills",
    body: "abcd",
    timestamp: 3,
  };
  const checkpoint: AgentMessage = {
    role: "checkpoint",
    title: "履歴 2 件を要約しました",
    body: "abcd",
    timestamp: 4,
  };
  // The model reads the body, not the head line: the title must not be
  // priced (it is UI text).
  assertEquals(
    estimateMessageTokens(checkpoint) === estimateMessageTokens(context),
    true,
  );
  // Every message costs its text plus structural overhead.
  assertEquals(estimateMessageTokens(user) > 1, true);
  assertEquals(estimateMessageTokens(notification) > 1, true);
});

Deno.test("estimateMessageTokens: images are priced by a fixed visual budget", () => {
  const withImage: AgentMessage = {
    role: "user",
    content: [{
      type: "image",
      data: "A".repeat(100_000),
      mimeType: "image/png",
    }],
    timestamp: 1,
  };
  const tokens = estimateMessageTokens(withImage);
  // The base64 payload is not text the model reads: counting its characters
  // would overstate a screenshot by orders of magnitude.
  assertEquals(tokens < 10_000, true);
  assertEquals(tokens >= IMAGE_TOKEN_ESTIMATE, true);
});

Deno.test("estimateMessageTokens: tool calls are priced by their arguments", () => {
  const call: AgentMessage = fauxAssistantMessage([
    fauxToolCall("bash", { command: "x".repeat(400) }, "t1"),
  ]);
  const text: AgentMessage = fauxAssistantMessage([fauxText("x".repeat(400))]);
  // A tool call's arguments are as much of the request as text is.
  assertEquals(
    estimateMessageTokens(call) >= estimateMessageTokens(text),
    true,
  );
});

Deno.test("estimateMessagesTokens and estimateToolTokens are additive", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "abcd" }], timestamp: 1 },
    fauxAssistantMessage([fauxText("abcd")]),
  ];
  assertEquals(
    estimateMessagesTokens(messages),
    estimateMessageTokens(messages[0]!) +
      estimateMessageTokens(messages[1]!),
  );
  const tool = { name: "bash", description: "Run a command", parameters: {} };
  assertEquals(estimateToolTokens(tool) > 0, true);
});
