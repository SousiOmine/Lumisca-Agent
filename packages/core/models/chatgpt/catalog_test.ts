import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Model } from "../../ai/catalog.ts";
import type { Api } from "../../domain/model.ts";

import { createInMemorySettingsRepo } from "../../settings/repo.ts";
import {
  CHATGPT_PROVIDER_ID,
  fetchChatGptModels,
  readChatGptModels,
  saveChatGptModels,
} from "./catalog.ts";
import type { FetchLike } from "./http.ts";
import { CHATGPT_API_BASE } from "./oauth.ts";
import { CHATGPT_COMPAT } from "./request.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("catalog maps the account's models and skips hidden entries", async () => {
  let headers: Headers | undefined;
  const fetchImpl: FetchLike = (input, init) => {
    assertEquals(String(input), CHATGPT_API_BASE + "/models");
    headers = new Headers(init?.headers);
    return Promise.resolve(
      json({
        models: [
          {
            slug: "gpt-6.1-sol",
            display_name: "GPT-6.1 Sol",
            visibility: "list",
            context_window: 400_000,
            supported_reasoning_levels: [
              { effort: "none" },
              { effort: "low" },
              { effort: "high" },
            ],
          },
          {
            slug: "gpt-6.1-sol-mini",
            display_name: "GPT-6.1 Sol mini",
            max_context_window: 128_000,
          },
          {
            slug: "internal-model",
            display_name: "Internal",
            visibility: "hidden",
          },
          { id: "id-only" },
          { display_name: "no id" },
          "not an entry",
        ],
      }),
    );
  };

  const models = await fetchChatGptModels(fetchImpl, { token: "access-1" });

  assertEquals(
    models.map((model) => model.id),
    ["gpt-6.1-sol", "gpt-6.1-sol-mini", "id-only"],
  );
  const first = models[0]!;
  assertEquals(first.name, "GPT-6.1 Sol");
  assertEquals(first.api, "openai-responses");
  assertEquals(first.provider, CHATGPT_PROVIDER_ID);
  assertEquals(first.baseUrl, CHATGPT_API_BASE);
  assertEquals(first.contextWindow, 400_000);
  assertEquals(first.reasoning, true);
  assertEquals(first.input, ["text", "image"]);
  assertEquals(first.compat, CHATGPT_COMPAT);
  assertEquals(first.thinkingLevelMap, {
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  });
  assertEquals(models[1]!.contextWindow, 128_000);
  assertEquals(headers?.get("authorization"), "Bearer access-1");
  assertEquals(headers?.get("chatgpt-account-id"), null);
  assertEquals(headers?.get("originator"), null);
});

test("catalog refuses a response without models", async () => {
  const fetchImpl: FetchLike = () => Promise.resolve(json({ models: [] }));
  const error = await assertRejects(
    () => fetchChatGptModels(fetchImpl, { token: "t" }),
    Error,
  );
  assert(error.message.includes("no usable models"));
});

test("catalog surfaces the HTTP failure", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(new Response("upstream down", { status: 503 }));
  const error = await assertRejects(
    () => fetchChatGptModels(fetchImpl, { token: "t" }),
    Error,
  );
  assert(error.message.includes("HTTP 503"));
  assert(error.message.includes("upstream down"));
});

test("the catalog round-trips through settings and ignores the old format", () => {
  const settings = createInMemorySettingsRepo();
  assertEquals(readChatGptModels(settings), []);

  const models: Model<Api>[] = [
    {
      id: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      api: "openai-responses",
      provider: CHATGPT_PROVIDER_ID,
      baseUrl: CHATGPT_API_BASE,
      reasoning: true,
      input: ["text", "image"],
    },
  ];
  saveChatGptModels(settings, models);
  assertEquals(readChatGptModels(settings), models);

  // A catalog stored by the previous Codex flow is an array; it must not
  // come back as if it were current.
  settings.setJson("chatgpt_models", models);
  assertEquals(readChatGptModels(settings), []);
});
