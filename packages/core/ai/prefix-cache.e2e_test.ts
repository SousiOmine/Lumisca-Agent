/**
 * Key-gated proof that a real provider serves the harness's requests from
 * its prompt cache.
 *
 * The keyless half (prefix-stability_test.ts) proves the requests are
 * append-extensions; this half proves the provider actually pays for them
 * once. It is skipped unless an API key is provided, because a cache read
 * can only be observed against a real endpoint:
 *
 *   LUMISCA_E2E_API_KEY=... deno test --allow-read --allow-write \
 *     --allow-run --allow-env --allow-net --allow-ffi --allow-sys \
 *     packages/core/ai/prefix-cache.e2e_test.ts
 *
 * `LUMISCA_E2E_MODEL` (default `deepseek-chat`) and `LUMISCA_E2E_BASE_URL`
 * (default DeepSeek's) select the endpoint; `DEEPSEEK_API_KEY` is accepted
 * as the key too. The system prompt is deliberately long: a provider caches
 * in fixed-size blocks (64 tokens for DeepSeek), so the shared prefix must
 * comfortably span one from the very first request.
 */
import { assert } from "@std/assert";
import { Agent } from "./agent.ts";
import { createStreamFn } from "./stream.ts";
import { languageModelFor } from "./lang-model.ts";
import { toLlmMessages } from "../types/notification.ts";
import type {
  AgentTool,
  Api,
  AssistantMessage,
  Model,
  StreamFn,
} from "./types.ts";

const API_KEY = Deno.env.get("LUMISCA_E2E_API_KEY") ??
  Deno.env.get("DEEPSEEK_API_KEY");
const MODEL_ID = Deno.env.get("LUMISCA_E2E_MODEL") ?? "deepseek-chat";
const BASE_URL = Deno.env.get("LUMISCA_E2E_BASE_URL") ??
  "https://api.deepseek.com/v1";

const SYSTEM_PROMPT =
  "You are a terse coding assistant used in an automated cache test. " +
  "Always follow instructions literally and exactly. When the user asks you " +
  "to look something up, call the lookup tool with the requested key and " +
  "wait for its result before answering. Never invent a value the tool has " +
  "not returned. After the tool returns, answer with a single short sentence " +
  "that repeats the returned value verbatim. Do not add explanations, do not " +
  "use markdown, do not ask follow-up questions. If the user asks anything " +
  "else, answer in one short sentence.";

function e2eModel(): Model<Api> {
  return {
    id: MODEL_ID,
    name: MODEL_ID,
    api: "openai-completions",
    provider: "lumisca-e2e",
    baseUrl: BASE_URL,
    input: ["text"],
    reasoning: false,
  } as unknown as Model<Api>;
}

/** The real transport over the endpoint the env selects. The agent passes
 * the model it was built with (see `e2eModel`), so the request is routed to
 * the configured endpoint. */
function e2eStreamFn(): StreamFn {
  return createStreamFn({
    languageModelFor: (requested) =>
      Promise.resolve(
        languageModelFor(requested, {
          apiKey: API_KEY!,
          source: "LUMISCA_E2E_API_KEY",
        }),
      ),
  });
}

function lookupTool(): AgentTool {
  return {
    name: "lookup",
    label: "Lookup",
    description: "Look up the stored value for a key.",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
    execute: () =>
      Promise.resolve({
        content: [{
          type: "text",
          text: "value(deploy-color) = azure-falcon-42",
        }],
        details: {},
      }),
  } as AgentTool;
}

Deno.test({
  name:
    "prefix cache: every request after the first is served from the provider's cache",
  ignore: API_KEY === undefined,
  fn: async () => {
    const agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model: e2eModel(),
        tools: [lookupTool()],
        messages: [],
      },
      streamFn: e2eStreamFn(),
      sessionId: `lumisca-prefix-cache-${Date.now()}`,
      convertToLlm: (messages) => toLlmMessages(messages),
    });

    // Turn 1 forces a tool call, so the turn has at least two steps (two
    // requests sharing a prefix); turn 2 adds one more over a longer prefix.
    await agent.prompt(
      'Look up the key "deploy-color" with the lookup tool and tell me the value.',
    );
    await agent.prompt("Thanks. Repeat that value one more time.");

    const usages = agent.state.messages
      .filter((message): message is AssistantMessage =>
        message.role === "assistant"
      )
      .map((message) => message.usage);
    assert(
      usages.length >= 3,
      `expected at least 3 requests (two steps plus a follow-up), got ${usages.length}`,
    );
    assert(
      usages.every((usage) => usage !== undefined),
      "the provider must report usage for every request",
    );

    // The first request has nothing to hit; every later one shares its
    // predecessor as a byte-identical prefix, so the provider must report
    // cached prompt tokens (DeepSeek's `prompt_cache_hit_tokens`).
    usages.slice(1).forEach((usage, index) => {
      assert(
        (usage.cacheRead ?? 0) > 0,
        `request ${index + 2} reported no cached prompt tokens ` +
          `(input ${usage.input}, cacheRead ${usage.cacheRead ?? 0}); ` +
          "the shared prefix was not reused",
      );
    });

    // The turn really did what it was asked (the value made it through the
    // tool into the answer), so the cache reads above describe a real turn.
    const finalText = agent.state.messages
      .filter((message): message is AssistantMessage =>
        message.role === "assistant"
      )
      .at(-1)!
      .content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    assert(
      finalText.includes("azure-falcon-42"),
      `the tool's value never reached the answer: ${finalText}`,
    );
  },
});
