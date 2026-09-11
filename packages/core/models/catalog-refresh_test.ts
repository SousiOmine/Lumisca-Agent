import { assert, assertEquals } from "@std/assert";
import type { ProviderMap } from "@opencode-ai/models";
import { LumiscaCore } from "../mod.ts";
import { DEV_PROVIDER_IDS } from "./dev-catalog.ts";
import { snapshotCatalog } from "./catalog-source.ts";

function liveProviders(): ProviderMap {
  // A live catalog that adds a model, drops a provider, and keeps the
  // rest: refresh must apply exactly that diff within the allow-list.
  const base = structuredClone(snapshotCatalog().providers);
  const openai = base["openai"];
  assert(openai !== undefined);
  const firstId = Object.keys(openai.models)[0]!;
  const first = openai.models[firstId]!;
  // The added model must be one the catalog exposes: models.dev's first
  // openai entry is an image model, which the agent filter drops.
  openai.models["brand-new-test-model"] = {
    ...structuredClone(first),
    id: "brand-new-test-model",
    name: "Brand New Test Model",
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
  };
  // "mistral" is dropped upstream: refresh must delete it locally.
  delete base["mistral"];
  // An allow-list-outsider must never leak into the registry.
  (base as Record<string, unknown>)["some-new-provider"] = {
    id: "some-new-provider",
    env: [],
    npm: "openai-compatible",
    name: "Some New Provider",
    doc: "https://example.test/new",
    models: {},
  };
  return base;
}

function stubFetch(map: ProviderMap) {
  return (_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(map), { status: 200 }),
    );
}

function failingFetch() {
  return (_url: string | URL | Request, _init?: RequestInit) =>
    Promise.reject(new Error("offline"));
}

Deno.test("refreshCatalog applies live additions and removals", async () => {
  const core = LumiscaCore.forTesting();
  try {
    assertEquals(core.getModelCatalogStatus().source, "snapshot");
    const before = core.listModels("openai").map((m) => m.id);
    assert(!before.includes("brand-new-test-model"));

    const status = await core.refreshModelCatalog({
      fetch: stubFetch(liveProviders()),
    });
    assertEquals(status.source, "live");
    assertEquals(status.error, undefined);

    assert(
      core.listModels("openai").some((m) => m.id === "brand-new-test-model"),
      "live-added model must appear",
    );
    assertEquals(
      core.listProviders().some((p) => p.id === "mistral"),
      false,
      "live-removed provider must disappear",
    );
    assertEquals(
      core.listProviders().some((p) => p.id === "some-new-provider"),
      false,
      "allow-list outsiders must never leak in",
    );
    // Untouched allow-list providers survive the refresh.
    assert(core.listProviders().some((p) => p.id === "openai"));
    assertEquals(core.getModelCatalogStatus().source, "live");
  } finally {
    await core.close();
  }
});

Deno.test("refreshCatalog keeps custom and user providers", async () => {
  const core = LumiscaCore.forTesting();
  try {
    await core.addUserProvider({
      id: "my-provider",
      name: "My Provider",
      baseUrl: "https://example.test/v1",
      api: "openai-completions",
      models: [{ id: "my-model" }],
    });
    await core.refreshModelCatalog({ fetch: stubFetch(liveProviders()) });
    assertEquals(
      core.listProviders().some((p) => p.id === "my-provider"),
      true,
      "user providers must survive a catalog refresh",
    );
    assertEquals(core.isUserProvider("my-provider"), true);
  } finally {
    await core.close();
  }
});

Deno.test("refreshCatalog keeps an existing session usable after upstream removal", async () => {
  const core = LumiscaCore.forTesting();
  try {
    const doomed = core.listModels("openai")[0]!;
    const ws = await core.createWorkspace("ws", [await Deno.makeTempDir()]);
    const session = core.createSession({
      workspaceId: ws.id,
      modelProvider: "openai",
      modelId: doomed.id,
    });
    assertEquals(core.getModel("openai", doomed.id)?.id, doomed.id);

    // Drop the whole provider upstream: the listing loses it, but the
    // existing session still opens and keeps its model metadata.
    const pruned = structuredClone(snapshotCatalog().providers);
    delete pruned["openai"];
    const status = await core.refreshModelCatalog({
      fetch: stubFetch(pruned),
    });
    assertEquals(status.source, "live");
    assertEquals(core.getModel("openai", doomed.id), undefined);
    assertEquals(
      core.models.isRetiredModel("openai", doomed.id),
      true,
    );
    const reopened = core.openSession(session.id);
    assertEquals(reopened.modelProvider, "openai");
    assertEquals(reopened.modelId, doomed.id);
    assertEquals(reopened.model?.id, doomed.id);
    // New sessions cannot select the retired model.
    await core.closeSession(session.id);
    const fresh = core.createSession({ workspaceId: ws.id });
    assert(
      !(fresh.modelProvider === "openai" && fresh.modelId === doomed.id) ||
        core.getModel("openai", doomed.id) !== undefined,
      "new sessions must not resolve a retired model",
    );
  } finally {
    await core.close();
  }
});

Deno.test("refreshCatalog reports custom-provider failure on the status", async () => {
  const core = LumiscaCore.forTesting();
  const previous = Deno.env.get("LUMISCA_MODELS_FILE");
  Deno.env.set("LUMISCA_MODELS_FILE", "C:/nonexistent/models.json");
  try {
    const status = await core.refreshModelCatalog({
      fetch: stubFetch(liveProviders()),
    });
    assert(
      typeof status.error === "string" &&
        status.error.includes("custom providers unavailable"),
      `expected a custom-provider error, got: ${status.error}`,
    );
    // The built-in catalog still applied; only the custom layer failed.
    assert(
      core.listModels("openai").some((m) => m.id === "brand-new-test-model"),
    );
  } finally {
    if (previous === undefined) Deno.env.delete("LUMISCA_MODELS_FILE");
    else Deno.env.set("LUMISCA_MODELS_FILE", previous);
    await core.close();
  }
});

Deno.test("refreshCatalog restores the built-in after a stale override is removed", async () => {
  const core = LumiscaCore.forTesting();
  const dir = await Deno.makeTempDir({ prefix: "lumisca-models-" });
  const path = `${dir}/models.json`;
  const previous = Deno.env.get("LUMISCA_MODELS_FILE");
  Deno.env.set("LUMISCA_MODELS_FILE", path);
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        providers: {
          "my-corp": {
            baseUrl: "https://example.test/v1",
            models: [{ id: "my-model" }],
          },
        },
      }),
    );
    await core.refreshModelCatalog({ fetch: stubFetch(liveProviders()) });
    assert(core.listProviders().some((p) => p.id === "my-corp"));
    // Remove the custom entry: the stale provider must disappear.
    await Deno.writeTextFile(path, JSON.stringify({ providers: {} }));
    await core.refreshModelCatalog({ fetch: stubFetch(liveProviders()) });
    assertEquals(
      core.listProviders().some((p) => p.id === "my-corp"),
      false,
      "stale custom providers must not linger",
    );
  } finally {
    if (previous === undefined) Deno.env.delete("LUMISCA_MODELS_FILE");
    else Deno.env.set("LUMISCA_MODELS_FILE", previous);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    await core.close();
  }
});

Deno.test("refreshCatalog falls back to snapshot when offline", async () => {
  const core = LumiscaCore.forTesting();
  try {
    const status = await core.refreshModelCatalog({
      fetch: failingFetch(),
    });
    assertEquals(status.source, "snapshot");
    assert(typeof status.error === "string" && status.error.length > 0);
    // The snapshot catalog is intact: every allow-list provider present.
    for (const id of DEV_PROVIDER_IDS) {
      if (core.models.isCustomProvider(id)) continue;
      assert(
        core.listProviders().some((p) => p.id === id),
        `snapshot provider missing after failed refresh: ${id}`,
      );
    }
  } finally {
    await core.close();
  }
});
