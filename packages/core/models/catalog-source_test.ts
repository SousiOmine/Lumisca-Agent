import { assert, assertEquals } from "@std/assert";
import type { ProviderMap } from "@opencode-ai/models";
import snapshot, {
  generatedAt as snapshotGeneratedAt,
} from "@opencode-ai/models/snapshot";
import { buildCatalogProviders, builtinProviders } from "./dev-catalog.ts";
import {
  CACHED_CATALOG_FILE,
  fetchLiveCatalog,
  isProviderMap,
  loadCachedCatalog,
  resolveCatalogSource,
  saveCachedCatalog,
  snapshotCatalog,
} from "./catalog-source.ts";
import { createInMemorySettingsRepo } from "../settings/repo.ts";
import { withTempDir } from "../test-utils.ts";
import { join } from "node:path";

function minimalProviders(): ProviderMap {
  return {
    openai: {
      id: "openai",
      env: ["OPENAI_API_KEY"],
      npm: "@ai-sdk/openai",
      name: "OpenAI",
      doc: "https://example.test/openai",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          description: "test",
          attachment: false,
          reasoning: false,
          tool_call: true,
          release_date: "2026-01-01",
          last_updated: "2026-01-01",
          modalities: { input: ["text"], output: ["text"] },
          open_weights: false,
          limit: { context: 1000, output: 100 },
        },
      },
    },
  } as unknown as ProviderMap;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  return (_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(handler(String(_url)));
}

Deno.test("fetchLiveCatalog returns the provider map on success", async () => {
  const source = await fetchLiveCatalog({
    fetch: stubFetch(() => jsonResponse(minimalProviders())),
  });
  assert(isProviderMap(source.providers));
  assertEquals(
    source.providers["openai"]?.models["test-model"]?.name,
    "Test Model",
  );
});

Deno.test("fetchLiveCatalog throws on non-2xx status", async () => {
  let threw = false;
  try {
    await fetchLiveCatalog({
      fetch: stubFetch(() => jsonResponse({ error: "down" }, 500)),
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("fetchLiveCatalog throws on unexpected shape", async () => {
  let threw = false;
  try {
    await fetchLiveCatalog({
      fetch: stubFetch(() => jsonResponse({ providers: {} })),
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("resolveCatalogSource prefers live and caches it", async () =>
  await withTempDir("lumisca-catalog-", async (root) => {
    const settings = createInMemorySettingsRepo();
    // Point the cache at the temp dir via a stubbed dir().
    const settingsWithDir = {
      ...settings,
      dir: () => root,
    };
    const { source, status } = await resolveCatalogSource({
      settings: settingsWithDir,
      fetch: stubFetch(() => jsonResponse(minimalProviders())),
    });
    assertEquals(status.source, "live");
    assertEquals(
      source.providers["openai"]?.models["test-model"]?.name,
      "Test Model",
    );
    // The live result was cached for the next offline start.
    const cached = loadCachedCatalog(root);
    assertEquals(
      cached?.providers["openai"]?.models["test-model"]?.name,
      "Test Model",
    );
    assert((await Deno.stat(join(root, CACHED_CATALOG_FILE))).isFile);
  }));

Deno.test("resolveCatalogSource falls back to cache when live fails", async () =>
  await withTempDir("lumisca-catalog-", async (root) => {
    saveCachedCatalog(root, {
      providers: minimalProviders(),
      generatedAt: "2026-09-08T00:00:00.000Z",
    });
    const settingsWithDir = {
      ...createInMemorySettingsRepo(),
      dir: () => root,
    };
    const { source, status } = await resolveCatalogSource({
      settings: settingsWithDir,
      fetch: stubFetch(() => {
        throw new Error("offline");
      }),
    });
    assertEquals(status.source, "cache");
    assertEquals(status.generatedAt, "2026-09-08T00:00:00.000Z");
    assert(typeof status.error === "string" && status.error.length > 0);
    assertEquals(
      source.providers["openai"]?.models["test-model"]?.name,
      "Test Model",
    );
  }));

Deno.test("resolveCatalogSource falls back to snapshot without a cache", async () => {
  const { source, status } = await resolveCatalogSource({
    settings: createInMemorySettingsRepo(),
    fetch: stubFetch(() => {
      throw new Error("offline");
    }),
  });
  assertEquals(status.source, "snapshot");
  assertEquals(status.generatedAt, snapshotGeneratedAt);
  assert(typeof status.error === "string" && status.error.length > 0);
  assertEquals(source.providers, snapshotCatalog().providers);
});

Deno.test("resolveCatalogSource falls back to snapshot on invalid shape", async () => {
  const { status } = await resolveCatalogSource({
    settings: createInMemorySettingsRepo(),
    fetch: stubFetch(() => jsonResponse({ hello: "world" })),
  });
  assertEquals(status.source, "snapshot");
  assert(typeof status.error === "string" && status.error.length > 0);
});

Deno.test("loadCachedCatalog ignores corrupt caches", async () =>
  await withTempDir("lumisca-catalog-", async (root) => {
    await Deno.writeTextFile(join(root, CACHED_CATALOG_FILE), "not-json{{{");
    assertEquals(loadCachedCatalog(root), undefined);
    await Deno.writeTextFile(
      join(root, CACHED_CATALOG_FILE),
      JSON.stringify({ providers: { openai: {} } }),
    );
    assertEquals(loadCachedCatalog(root), undefined);
    assertEquals(loadCachedCatalog(undefined), undefined);
  }));

Deno.test("saveCachedCatalog is a no-op without a directory", () => {
  saveCachedCatalog(undefined, { providers: minimalProviders() });
});

Deno.test("buildCatalogProviders maps a foreign provider map like the snapshot path", () => {
  const fromSnapshot = builtinProviders();
  const fromLive = buildCatalogProviders(snapshot.providers);
  assertEquals(
    fromLive.map((p) => p.id),
    fromSnapshot.map((p) => p.id),
  );
  assertEquals(
    fromLive.map((p) => p.getModels().length),
    fromSnapshot.map((p) => p.getModels().length),
  );
  // Allow-listing holds for foreign maps: unknown providers never leak in.
  const extended = {
    ...minimalProviders(),
    "some-new-provider": {
      id: "some-new-provider",
      env: [],
      npm: "openai-compatible",
      name: "Some New Provider",
      doc: "https://example.test/new",
      models: {},
    },
  } as unknown as ProviderMap;
  const built = buildCatalogProviders(extended);
  assertEquals(built.map((p) => p.id), ["openai"]);
  assertEquals(built[0]?.getModels().map((m) => m.id), ["test-model"]);
});

Deno.test("isProviderMap rejects empty maps", () => {
  assertEquals(isProviderMap({}), false);
});

Deno.test("isProviderMap rejects non-maps", () => {
  assertEquals(isProviderMap(undefined), false);
  assertEquals(isProviderMap({ openai: { models: "nope" } }), false);
  assertEquals(
    isProviderMap({ openai: { models: { m: { id: "m" } } } }),
    false,
  );
});

Deno.test("fetchLiveCatalog rejects an empty provider map", async () => {
  let threw = false;
  try {
    await fetchLiveCatalog({
      fetch: stubFetch(() => jsonResponse({})),
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
