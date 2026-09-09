import { assertEquals, assertThrows } from "@std/assert";
import { languageModelFor, sessionHeadersFor } from "./lang-model.ts";
import { opencodeGoProvider } from "../models/dev-catalog.ts";
import { reasoningForceOption } from "./stream.ts";
import type { Api, Model } from "./types.ts";

/** A plain first-party OpenAI model (no session affinity). */
const openaiModel: Model<Api> = {
  id: "gpt-test",
  name: "gpt-test",
  api: "openai-completions",
  provider: "openai",
};

Deno.test(
  "sessionHeadersFor sends the conversation id as x-opencode-session for OpenCode Go",
  () => {
    // The model comes from the real models.dev catalog so the test also
    // pins the transport's provider-id constant against catalog renames.
    const model = opencodeGoProvider().getModels()[0]!;
    assertEquals(
      sessionHeadersFor(model, { sessionId: "conv-1" }),
      { "x-opencode-session": "conv-1" },
    );
  },
);

Deno.test("sessionHeadersFor is a no-op for providers without session affinity", () => {
  assertEquals(
    sessionHeadersFor(openaiModel, { sessionId: "conv-1" }),
    undefined,
  );
  assertEquals(sessionHeadersFor(openaiModel), undefined);
});

Deno.test("sessionHeadersFor fails fast when an OpenCode Go request has no conversation id", () => {
  const model = opencodeGoProvider().getModels()[0]!;
  assertThrows(
    () => sessionHeadersFor(model),
    Error,
    "x-opencode-session",
  );
  assertThrows(
    () => sessionHeadersFor(model, { sessionId: "" }),
    Error,
    "x-opencode-session",
  );
});

Deno.test("openai-responses resolves to the official Responses model even for third-party gateways", () => {
  const go = opencodeGoProvider();
  const muse = go.getModels().find((m) =>
    m.id === "muse-spark-1.3-contributor"
  )!;
  assertEquals(muse.api, "openai-responses");

  const lm = languageModelFor(muse, { apiKey: "test-key", source: "test" });
  const unwrapped = lm as unknown as {
    provider?: string;
    modelId?: string;
    config?: { baseURL?: string };
  };
  // The @ai-sdk/openai responses model, not the chat-completions fallback.
  assertEquals(unwrapped.modelId, "muse-spark-1.3-contributor");
  assertEquals(
    unwrapped.provider?.endsWith(".responses"),
    true,
    `expected a .responses provider, got ${unwrapped.provider}`,
  );
  // It still targets the gateway's base URL and appends /responses.
  assertEquals(unwrapped.config?.baseURL, "https://opencode.ai/zen/go/v1");
});

Deno.test("OpenCode Go chat/anthropic models resolve to their declared transports", () => {
  const go = opencodeGoProvider();
  const byId = new Map(go.getModels().map((m) => [m.id, m]));
  const key = { apiKey: "test-key", source: "test" };

  // Chat surface: the OpenAI-compatible chat model on the gateway base URL.
  const flash = byId.get("deepseek-v4-flash")!;
  assertEquals(flash.api, "openai-completions");
  const chatLm = languageModelFor(flash, key) as unknown as {
    provider?: string;
    modelId?: string;
  };
  assertEquals(chatLm.provider, "opencode-go:deepseek-v4-flash.chat");
  assertEquals(chatLm.modelId, "deepseek-v4-flash");

  // Anthropic surface: model id stays plain while the base URL receives
  // the appended `/messages` path.
  const minimax = byId.get("minimax-m3")!;
  assertEquals(minimax.api, "anthropic-messages");
  const anthropicLm = languageModelFor(minimax, key) as unknown as {
    provider?: string;
    modelId?: string;
  };
  assertEquals(anthropicLm.modelId, "minimax-m3");
});

Deno.test("reasoningForceOption forces unknown Responses-API models into reasoning mode", () => {
  const go = opencodeGoProvider();
  const muse = go.getModels().find((m) =>
    m.id === "muse-spark-1.3-contributor"
  )!;
  // A reasoning hint is sent, so the SDK must be told this unknown model
  // id is a reasoning model — otherwise the hint is dropped silently.
  assertEquals(reasoningForceOption(muse, "xhigh"), {
    openai: { forceReasoning: true },
  });
  // No hint, no option: non-thinking calls keep their previous shape.
  assertEquals(reasoningForceOption(muse, undefined), undefined);
  // Chat-surface models send reasoning_effort unconditionally and need
  // no override.
  const flash = go.getModels().find((m) => m.id === "deepseek-v4-flash")!;
  assertEquals(reasoningForceOption(flash, "high"), undefined);
  // Non-reasoning models never get the override, even on Responses.
  const plain: Model<Api> = {
    id: "plain",
    name: "plain",
    api: "openai-responses",
    provider: "custom",
    reasoning: false,
  };
  assertEquals(reasoningForceOption(plain, "high"), undefined);
});

Deno.test("muse-spark actually sends reasoning.effort on the wire", async () => {
  // End-to-end through the real @ai-sdk/openai Responses model: the SDK
  // classifies unknown model ids as non-reasoning and drops the hint, so
  // the transport must attach forceReasoning (see reasoningForceOption).
  const go = opencodeGoProvider();
  const muse = go.getModels().find((m) =>
    m.id === "muse-spark-1.3-contributor"
  )!;
  const lm = languageModelFor(muse, {
    apiKey: "test-key",
    source: "test",
  }) as unknown as {
    getArgs: (o: unknown) => Promise<{ args: Record<string, unknown> }>;
  };
  const prompt = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
  const without = await lm.getArgs({ prompt, reasoning: "xhigh" });
  // Sanity: without the override the SDK drops the hint (the reported bug).
  assertEquals(
    (without.args as Record<string, unknown>).reasoning,
    undefined,
  );
  const forced = await lm.getArgs({
    prompt,
    reasoning: "xhigh",
    providerOptions: reasoningForceOption(muse, "xhigh"),
  });
  assertEquals((forced.args as Record<string, unknown>).reasoning, {
    effort: "xhigh",
    summary: "detailed",
  });
});
