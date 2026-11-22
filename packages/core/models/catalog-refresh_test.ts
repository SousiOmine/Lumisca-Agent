import { test } from "bun:test";
import * as fsp from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { forTestingCore } from "@lumisca/core";
import type { ProviderMap } from "@opencode-ai/models";
import { assert, assertEquals } from "@std/assert";
import { LumiscaCore } from "../mod.ts";
import { snapshotCatalog } from "./catalog-source.ts";
import { DEV_PROVIDER_IDS } from "./dev-catalog.ts";

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
    Promise.resolve(new Response(JSON.stringify(map), { status: 200 }));
}

function failingFetch() {
  return (_url: string | URL | Request, _init?: RequestInit) =>
    Promise.reject(new Error("offline"));
}

test("refreshCatalog applies live additions and removals", async () => {
  const core = forTestingCore();
  try {
    assertEquals(
      core.services.models.getModelCatalogStatus().source,
      "snapshot",
    );
    const before = core.services.models.listModels("openai").map((m) => m.id);
    assert(!before.includes("brand-new-test-model"));

    const status = await core.services.models.refreshModelCatalog({
      fetch: stubFetch(liveProviders()),
    });
    assertEquals(status.source, "live");
    assertEquals(status.error, undefined);

    assert(
      core.services.models
        .listModels("openai")
        .some((m) => m.id === "brand-new-test-model"),
      "live-added model must appear",
    );
    assertEquals(
      core.services.models.listProviders().some((p) => p.id === "mistral"),
      false,
      "live-removed provider must disappear",
    );
    assertEquals(
      core.services.models
        .listProviders()
        .some((p) => p.id === "some-new-provider"),
      false,
      "allow-list outsiders must never leak in",
    );
    // Untouched allow-list providers survive the refresh.
    assert(core.services.models.listProviders().some((p) => p.id === "openai"));
    assertEquals(core.services.models.getModelCatalogStatus().source, "live");
  } finally {
    await core.close();
  }
});

test("refreshCatalog keeps custom and user providers", async () => {
  const core = forTestingCore();
  try {
    await core.services.models.addUserProvider({
      id: "my-provider",
      name: "My Provider",
      baseUrl: "https://example.test/v1",
      api: "openai-completions",
      models: [{ id: "my-model" }],
    });
    await core.services.models.refreshModelCatalog({
      fetch: stubFetch(liveProviders()),
    });
    assertEquals(
      core.services.models.listProviders().some((p) => p.id === "my-provider"),
      true,
      "user providers must survive a catalog refresh",
    );
    assertEquals(core.services.models.isUserProvider("my-provider"), true);
  } finally {
    await core.close();
  }
});

test("refreshCatalog keeps an existing session usable after upstream removal", async () => {
  const core = forTestingCore();
  try {
    const doomed = core.services.models.listModels("openai")[0]!;
    const ws = await core.services.workspaces.create("ws", [
      await fsp.mkdtemp(pathJoin(osTmpdir(), "tmp-")),
    ]);
    const session = await core.services.sessions.createSession({
      workspaceId: ws.id,
      modelProvider: "openai",
      modelId: doomed.id,
    });
    assertEquals(
      core.services.models.getModel("openai", doomed.id)?.id,
      doomed.id,
    );

    // Drop the whole provider upstream: the listing loses it, but the
    // existing session still opens and keeps its model metadata.
    const pruned = structuredClone(snapshotCatalog().providers);
    delete pruned["openai"];
    const status = await core.services.models.refreshModelCatalog({
      fetch: stubFetch(pruned),
    });
    assertEquals(status.source, "live");
    assertEquals(core.services.models.getModel("openai", doomed.id), undefined);
    assertEquals(core.models.isRetiredModel("openai", doomed.id), true);
    const reopened = core.services.sessions.openSession(session.id);
    assertEquals(reopened.modelProvider, "openai");
    assertEquals(reopened.modelId, doomed.id);
    assertEquals(reopened.model?.id, doomed.id);
    // New sessions cannot select the retired model. Another provider is
    // configured first, so a default model exists at all: the built-in
    // catalog alone does not count (nothing else is configured here).
    await core.services.sessions.closeSession(session.id);
    await core.services.models.setProviderApiKey("anthropic", "sk-ant-test");
    const fresh = await core.services.sessions.createSession({
      workspaceId: ws.id,
    });
    assertEquals(
      fresh.modelProvider,
      "anthropic",
      "new sessions must resolve a configured provider, never the retired model",
    );
  } finally {
    await core.close();
  }
});

test("a retired provider still resolves the credential it served with", async () => {
  const core = forTestingCore();
  try {
    // A stored key is what a session created before the removal used.
    await core.services.models.setProviderApiKey("mistral", "sk-mistral-test");
    const pruned = structuredClone(snapshotCatalog().providers);
    delete pruned["mistral"];
    await core.services.models.refreshModelCatalog({
      fetch: stubFetch(pruned),
    });
    assertEquals(core.services.models.getModel("mistral", "any"), undefined);

    // The retired entry IS the provider that served those sessions, so its
    // auth definition survives: without it every retired session would fail
    // with "Provider is not configured", which is the opposite of the point
    // of keeping the provider alive.
    const retired = core.models.getProviderWithRetired("mistral");
    assert(retired !== undefined, "the retired provider must stay resolvable");
    const resolved = await retired.resolveCredential({
      credential: { type: "api_key", key: "sk-mistral-test" },
      env: {},
    });
    assertEquals(resolved?.auth.apiKey, "sk-mistral-test");
  } finally {
    await core.close();
  }
});

test("refreshCatalog reports custom-provider failure on the status", async () => {
  // The models file appears *after* the core is built: only the refresh
  // re-reads the custom sources, so the failure lands on the status rather
  // than in the constructor.
  const vars: Record<string, string> = {};
  const core = forTestingCore([], () => vars);
  vars.LUMISCA_MODELS_FILE = "C:/nonexistent/models.json";
  try {
    const status = await core.services.models.refreshModelCatalog({
      fetch: stubFetch(liveProviders()),
    });
    assert(
      typeof status.error === "string" &&
        status.error.includes("custom providers unavailable"),
      `expected a custom-provider error, got: ${status.error}`,
    );
    // The built-in catalog still applied; only the custom layer failed.
    assert(
      core.services.models
        .listModels("openai")
        .some((m) => m.id === "brand-new-test-model"),
    );
  } finally {
    await core.close();
  }
});

test("refreshCatalog restores the built-in after a stale override is removed", async () => {
  const dir = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-models-"));
  const path = `${dir}/models.json`;
  const vars: Record<string, string> = {};
  const core = forTestingCore([], () => vars);
  try {
    await fsp.writeFile(
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
    vars.LUMISCA_MODELS_FILE = path;
    await core.services.models.refreshModelCatalog({
      fetch: stubFetch(liveProviders()),
    });
    assert(
      core.services.models.listProviders().some((p) => p.id === "my-corp"),
    );
    // Remove the custom entry: the stale provider must disappear.
    await fsp.writeFile(path, JSON.stringify({ providers: {} }));
    await core.services.models.refreshModelCatalog({
      fetch: stubFetch(liveProviders()),
    });
    assertEquals(
      core.services.models.listProviders().some((p) => p.id === "my-corp"),
      false,
      "stale custom providers must not linger",
    );
  } finally {
    await fsp.rm(dir, { recursive: true }).catch(() => {});
    await core.close();
  }
});

test("refreshCatalog falls back to snapshot when offline", async () => {
  const core = forTestingCore();
  try {
    const status = await core.services.models.refreshModelCatalog({
      fetch: failingFetch(),
    });
    assertEquals(status.source, "snapshot");
    assert(typeof status.error === "string" && status.error.length > 0);
    // The snapshot catalog is intact: every allow-list provider present.
    for (const id of DEV_PROVIDER_IDS) {
      if (core.models.isCustomProvider(id)) continue;
      assert(
        core.services.models.listProviders().some((p) => p.id === id),
        `snapshot provider missing after failed refresh: ${id}`,
      );
    }
  } finally {
    await core.close();
  }
});
