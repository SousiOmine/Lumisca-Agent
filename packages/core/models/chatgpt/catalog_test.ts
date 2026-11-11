import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Api, Model } from "../../ai/types.ts";
import { createInMemorySettingsRepo } from "../../settings/repo.ts";
import {
  CHATGPT_PROVIDER_ID,
  fetchChatGptModels,
  readChatGptModels,
  saveChatGptModels,
} from "./catalog.ts";
import type { FetchLike } from "./http.ts";
import { CHATGPT_API_BASE } from "./oauth.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("catalog maps the account's models", async () => {
  let headers: Headers | undefined;
  const fetchImpl: FetchLike = (input, init) => {
    assertEquals(
      String(input),
      `${CHATGPT_API_BASE}/models?client_version=1.0.0`,
    );
    headers = new Headers(init?.headers);
    return Promise.resolve(
      json({
        models: [
          {
            slug: "gpt-5.3-codex",
            display_name: "GPT-5.3 Codex",
            context_window: 400_000,
            supported_reasoning_levels: [
              { effort: "none" },
              { effort: "low" },
              { effort: "high" },
            ],
          },
          {
            slug: "gpt-5.3-codex-spark",
            display_name: "GPT-5.3 Codex Spark",
            max_context_window: 128_000,
          },
          { id: "id-only" },
          { display_name: "no id" },
          "not an entry",
        ],
      }),
    );
  };

  const models = await fetchChatGptModels(fetchImpl, {
    token: "access-1",
    accountId: "acct-1",
  });

  assertEquals(
    models.map((model) => model.id),
    ["gpt-5.3-codex", "gpt-5.3-codex-spark", "id-only"],
  );
  const first = models[0]!;
  assertEquals(first.name, "GPT-5.3 Codex");
  assertEquals(first.api, "openai-responses");
  assertEquals(first.provider, CHATGPT_PROVIDER_ID);
  assertEquals(first.baseUrl, CHATGPT_API_BASE);
  assertEquals(first.contextWindow, 400_000);
  assertEquals(first.reasoning, true);
  assertEquals(first.input, ["text", "image"]);
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
  assertEquals(headers?.get("chatgpt-account-id"), "acct-1");
  assertEquals(headers?.get("originator"), "lumisca");
});

Deno.test("catalog refuses a response without models", async () => {
  const fetchImpl: FetchLike = () => Promise.resolve(json({ models: [] }));
  const error = await assertRejects(
    () => fetchChatGptModels(fetchImpl, { token: "t", accountId: "a" }),
    Error,
  );
  assert(error.message.includes("no usable models"));
});

Deno.test("catalog surfaces the HTTP failure", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(new Response("upstream down", { status: 503 }));
  const error = await assertRejects(
    () => fetchChatGptModels(fetchImpl, { token: "t", accountId: "a" }),
    Error,
  );
  assert(error.message.includes("HTTP 503"));
  assert(error.message.includes("upstream down"));
});

Deno.test("the catalog round-trips through settings", () => {
  const settings = createInMemorySettingsRepo();
  assertEquals(readChatGptModels(settings), []);

  const models: Model<Api>[] = [
    {
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      api: "openai-responses",
      provider: CHATGPT_PROVIDER_ID,
      baseUrl: CHATGPT_API_BASE,
      reasoning: true,
      input: ["text", "image"],
    },
  ];
  saveChatGptModels(settings, models);
  assertEquals(readChatGptModels(settings), models);
});
