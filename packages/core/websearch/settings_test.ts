import { assert, assertEquals, assertThrows } from "@std/assert";
import { CoreError } from "../errors.ts";
import { WEB_SEARCH_KEY } from "../shared/settings-keys.ts";
import type { FetchLike } from "./types.ts";
import { createWebSearchSettingsStore } from "./settings.ts";
import { WebSearchService } from "./service.ts";
import { parseWebSearchSettings } from "./settings.ts";

/** In-memory settings, the shape the repo exposes to consumers. */
function memorySettings() {
  const values = new Map<string, string>();
  return {
    values,
    get: (key: string) => values.get(key),
    set: (key: string, value: string) => void values.set(key, value),
  };
}

/** A transport that answers every search with one hit. */
const okFetch: FetchLike = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        results: [{
          title: "Hit",
          url: "https://example.com/",
          snippet: "text",
        }],
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );

/** A transport that rejects the key. */
const unauthorizedFetch: FetchLike = () =>
  Promise.resolve(
    new Response(JSON.stringify({ error: "bad key" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  );

function service(fetchImpl: FetchLike = okFetch) {
  const settings = memorySettings();
  const store = createWebSearchSettingsStore(settings);
  const web = new WebSearchService({
    settings: store,
    locale: () => "ja",
    fetch: fetchImpl,
  });
  return { settings, store, web };
}

Deno.test("a malformed or unset setting reads as no provider", () => {
  for (const raw of [undefined, "", "nonsense", "[]", "null"]) {
    const parsed = parseWebSearchSettings(raw);
    assertEquals(parsed.defaultId, null);
    assertEquals(parsed.providers.size, 0);
  }
});

Deno.test("a provider without a key, or with an unknown id, is dropped", () => {
  const parsed = parseWebSearchSettings(
    JSON.stringify({
      default: "gone",
      providers: {
        exa: { apiKey: "  " },
        brave: { apiKey: "b" },
        removed: { apiKey: "x" },
      },
    }),
  );
  assertEquals([...parsed.providers.keys()], ["brave"]);
  // The stored default named a dropped provider: the configured one takes
  // over rather than leaving search switched on but unusable.
  assertEquals(parsed.defaultId, "brave");
});

Deno.test("the first provider added becomes the default", () => {
  const { web, settings } = service();
  const view = web.add({ id: "exa", apiKey: "  key  " });
  assertEquals(view.defaultId, "exa");
  assertEquals(view.providers.map((p) => p.id), ["exa"]);
  assertEquals(view.providers[0]?.hasApiKey, true);
  // The key is stored trimmed, and it stays in the settings entry (never
  // through the generic surface).
  const stored = settings.values.get(WEB_SEARCH_KEY) ?? "";
  assert(stored.includes("key"));
  assert(!stored.includes("  key  "));
  assertEquals(view.available.map((p) => p.id).includes("exa"), false);
});

Deno.test("adding a provider twice, or with no key, is refused", () => {
  const { web } = service();
  web.add({ id: "exa", apiKey: "k" });
  assertThrows(
    () => web.add({ id: "exa", apiKey: "k" }),
    CoreError,
    "already configured",
  );
  assertThrows(
    () => web.add({ id: "brave", apiKey: "   " }),
    CoreError,
    "must not be empty",
  );
  assertThrows(() => web.add({ id: "nope", apiKey: "k" }), CoreError);
});

Deno.test("an empty key on update keeps the stored one", () => {
  const { web, store } = service();
  web.add({ id: "exa", apiKey: "first" });
  web.update("exa", { apiKey: "   " });
  assertEquals(store.read().providers.get("exa")?.apiKey, "first");
  web.update("exa", { apiKey: "second" });
  assertEquals(store.read().providers.get("exa")?.apiKey, "second");
});

Deno.test("removing the default hands it to the next provider", () => {
  const { web } = service();
  web.add({ id: "exa", apiKey: "k" });
  web.add({ id: "brave", apiKey: "k" });
  const afterFirst = web.remove("exa");
  assertEquals(afterFirst.defaultId, "brave");
  assertEquals(afterFirst.providers.map((p) => p.id), ["brave"]);
  assertEquals(web.provider()?.id, "brave");

  // Removing the last one leaves nothing to search with.
  const afterAll = web.remove("brave");
  assertEquals(afterAll.defaultId, null);
  assertEquals(afterAll.providers, []);
  assertEquals(web.provider(), null);
});

Deno.test("removing a provider that is not the default keeps the default", () => {
  const { web } = service();
  web.add({ id: "exa", apiKey: "k" });
  web.add({ id: "brave", apiKey: "k" });
  web.setDefault("brave");
  const after = web.remove("exa");
  assertEquals(after.defaultId, "brave");
});

Deno.test("the default can be chosen and cleared", () => {
  const { web, store } = service();
  web.add({ id: "exa", apiKey: "k" });
  web.add({ id: "brave", apiKey: "k" });
  assertEquals(web.setDefault("brave").defaultId, "brave");
  assertEquals(store.read().defaultId, "brave");

  assertEquals(web.setDefault(null).defaultId, null);
  // Clearing the default keeps the configuration: the provider is still
  // there, only search is off.
  assertEquals(store.read().providers.size, 2);
  assertThrows(() => web.setDefault("gone"), CoreError);
});

Deno.test("the provider is exactly the default one", () => {
  const { web } = service();
  assertEquals(web.provider(), null);
  web.add({ id: "exa", apiKey: "k" });
  web.add({ id: "brave", apiKey: "k" });
  assertEquals(web.provider()?.id, "exa");
  web.setDefault("brave");
  assertEquals(web.provider()?.id, "brave");
  web.setDefault(null);
  assertEquals(web.provider(), null);
});

Deno.test("a key check reports success and failure without saving", async () => {
  const passing = service(okFetch);
  const ok = await passing.web.test({ id: "exa", apiKey: "k" });
  assertEquals(ok, { ok: true, detail: null, results: 1 });
  // Nothing was written: a check is not a save.
  assertEquals(passing.settings.values.size, 0);

  const failing = service(unauthorizedFetch);
  const failed = await failing.web.test({ id: "exa", apiKey: "k" });
  assertEquals(failed.ok, false);
  assertEquals(failed.results, 0);
  // The reason is shown to the user, in the app language.
  assert(failed.detail?.includes("API キー"));
});

Deno.test("a check without a key fails before reaching the network", async () => {
  let called = false;
  const { web } = service(() => {
    called = true;
    return Promise.resolve(new Response("{}"));
  });
  const result = await web.test({ id: "exa", apiKey: "   " });
  assertEquals(result.ok, false);
  assertEquals(called, false);
});
