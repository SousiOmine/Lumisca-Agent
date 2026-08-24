import { join } from "node:path";
import { assertEquals, assertThrows } from "@std/assert";
import { LumiscaCore } from "../mod.ts";
import {
  CUSTOM_PROVIDER_ID,
  customProviderFromEnv,
  customProvidersFromModelsFile,
  loadCustomProviders,
} from "./custom.ts";

const ENV_KEYS = [
  "LUMISCA_BASE_URL",
  "LUMISCA_MODEL",
  "LUMISCA_API_KEY",
  "LUMISCA_MODELS_FILE",
  "LUMISCA_API_KEY_CUSTOM",
];

/** Run `body` with a clean custom-provider env, then restore it. The
 * env-var custom provider is read at ModelManager construction, so tests
 * must never leak these vars into other test files (deno test runs files
 * in parallel processes). */
async function withEnv(
  env: Record<string, string>,
  body: () => void | Promise<void>,
): Promise<void> {
  const saved = new Map(ENV_KEYS.map((k) => [k, Deno.env.get(k)]));
  for (const k of ENV_KEYS) Deno.env.delete(k);
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  try {
    await body();
  } finally {
    for (const k of ENV_KEYS) Deno.env.delete(k);
    for (const [k, v] of saved) {
      if (v !== undefined) Deno.env.set(k, v);
    }
  }
}

async function writeModelsFile(content: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-models-" });
  const path = join(dir, "models.json");
  await Deno.writeTextFile(path, content);
  return path;
}

Deno.test("env vars register the custom provider", () => {
  withEnv({
    LUMISCA_BASE_URL: "http://localhost:5002/v1",
    LUMISCA_MODEL: "deepseek-chat",
  }, () => {
    const provider = customProviderFromEnv();
    assertEquals(provider !== undefined, true);
    assertEquals(provider!.id, CUSTOM_PROVIDER_ID);
    assertEquals(provider!.name, "Custom (OpenAI-compatible)");
    assertEquals(provider!.baseUrl, "http://localhost:5002/v1");
    const models = provider!.getModels();
    assertEquals(models.length, 1);
    assertEquals(models[0]!.id, "deepseek-chat");
    assertEquals(models[0]!.api, "openai-completions");
    assertEquals(models[0]!.baseUrl, "http://localhost:5002/v1");
    assertEquals(models[0]!.contextWindow, 128_000);
    assertEquals(models[0]!.maxTokens, 16_384);
    assertEquals(models[0]!.reasoning, false);
  });
});

Deno.test("env custom provider is absent without LUMISCA_BASE_URL", () => {
  withEnv({}, () => {
    assertEquals(customProviderFromEnv(), undefined);
    assertEquals(loadCustomProviders().length, 0);
  });
});

Deno.test("env custom provider requires LUMISCA_MODEL", () => {
  withEnv({ LUMISCA_BASE_URL: "http://localhost:5002/v1" }, () => {
    assertThrows(() => customProviderFromEnv(), Error, "LUMISCA_MODEL");
  });
});

Deno.test("models.json registers multiple providers and models", async () => {
  const path = await writeModelsFile(JSON.stringify({
    providers: {
      "distill-gym": {
        name: "distill-gym proxy",
        baseUrl: "http://host.containers.internal:5002/v1",
        apiKey: "${DISTILL_GYM_KEY}",
        models: [
          { id: "deepseek-chat", contextWindow: 64000, maxTokens: 8000 },
          { id: "deepseek-reasoner", reasoning: true },
        ],
      },
      other: {
        baseUrl: "http://other:8000/v1",
        models: [{ id: "m1" }],
      },
    },
  }));
  await withEnv({ LUMISCA_MODELS_FILE: path }, () => {
    const providers = customProvidersFromModelsFile();
    assertEquals(providers.length, 2);

    const dg = providers.find((p) => p.id === "distill-gym")!;
    assertEquals(dg.name, "distill-gym proxy");
    const models = dg.getModels();
    assertEquals(models.length, 2);
    assertEquals(models[0]!.id, "deepseek-chat");
    assertEquals(models[0]!.api, "openai-completions");
    assertEquals(models[0]!.contextWindow, 64000);
    assertEquals(models[0]!.maxTokens, 8000);
    assertEquals(models[1]!.id, "deepseek-reasoner");
    assertEquals(models[1]!.reasoning, true);

    const other = providers.find((p) => p.id === "other")!;
    assertEquals(other.getModels()[0]!.baseUrl, "http://other:8000/v1");
  });
  await Deno.remove(join(path, ".."), { recursive: true });
});

Deno.test("models.json apiKey ${ENV} resolves from the environment", async () => {
  const path = await writeModelsFile(JSON.stringify({
    providers: {
      custom: {
        baseUrl: "http://localhost:5002/v1",
        apiKey: "${LUMISCA_TEST_PROXY_KEY}",
        models: [{ id: "m" }],
      },
    },
  }));
  await withEnv({
    LUMISCA_MODELS_FILE: path,
    LUMISCA_TEST_PROXY_KEY: "secret-value",
  }, async () => {
    const core = LumiscaCore.forTesting();
    try {
      const provider = core.listProviders().find((p) => p.id === "custom");
      assertEquals(provider !== undefined, true);
      assertEquals(await core.hasProviderAuth("custom"), true);
      // models.json providers are Lumisca's own config: they count as
      // configured even though the key comes from an env var.
      assertEquals(await core.hasConfiguredAuth("custom"), true);
      const check = await core.checkAuth("custom");
      assertEquals(check?.source, "LUMISCA_TEST_PROXY_KEY");
    } finally {
      core.close();
    }
  });
  await Deno.remove(join(path, ".."), { recursive: true });
});

Deno.test("models.json literal apiKey resolves without env vars", async () => {
  const path = await writeModelsFile(JSON.stringify({
    providers: {
      custom: {
        baseUrl: "http://localhost:5002/v1",
        apiKey: "literal-key",
        models: [{ id: "m" }],
      },
    },
  }));
  await withEnv({ LUMISCA_MODELS_FILE: path }, async () => {
    const core = LumiscaCore.forTesting();
    try {
      const check = await core.checkAuth("custom");
      assertEquals(check?.source, "models.json");
    } finally {
      core.close();
    }
  });
  await Deno.remove(join(path, ".."), { recursive: true });
});

Deno.test("models.json provider headers propagate to every model", async () => {
  const path = await writeModelsFile(JSON.stringify({
    providers: {
      proxied: {
        baseUrl: "http://proxy:8000/v1",
        headers: {
          "x-api-key": "proxy-secret",
          "X-Custom": "yes",
        },
        models: [{ id: "m1" }, { id: "m2", baseUrl: "http://direct:1/v1" }],
      },
    },
  }));
  await withEnv({ LUMISCA_MODELS_FILE: path }, () => {
    const providers = customProvidersFromModelsFile();
    const proxied = providers.find((p) => p.id === "proxied")!;
    // pi-ai only sends model.headers on requests, so the provider-level
    // headers must land on each model to take effect.
    for (const model of proxied.getModels()) {
      assertEquals(model.headers, {
        "x-api-key": "proxy-secret",
        "X-Custom": "yes",
      });
    }
  });
  await Deno.remove(join(path, ".."), { recursive: true });
});

Deno.test("models.json without apiKey falls back to LUMISCA_API_KEY_<ID>", async () => {
  const path = await writeModelsFile(JSON.stringify({
    providers: {
      custom: {
        baseUrl: "http://localhost:5002/v1",
        models: [{ id: "m" }],
      },
    },
  }));
  await withEnv({
    LUMISCA_MODELS_FILE: path,
    LUMISCA_API_KEY_CUSTOM: "from-env",
  }, async () => {
    const core = LumiscaCore.forTesting();
    try {
      const check = await core.checkAuth("custom");
      assertEquals(check?.source, "LUMISCA_API_KEY_CUSTOM");
    } finally {
      core.close();
    }
  });
  await Deno.remove(join(path, ".."), { recursive: true });
});

Deno.test("models.json without baseUrl throws", async () => {
  const path = await writeModelsFile(JSON.stringify({
    providers: { custom: { models: [{ id: "m" }] } },
  }));
  await withEnv({ LUMISCA_MODELS_FILE: path }, () => {
    assertThrows(() => customProvidersFromModelsFile(), Error, "baseUrl");
  });
  await Deno.remove(join(path, ".."), { recursive: true });
});

Deno.test("models.json with unsupported api throws", async () => {
  const path = await writeModelsFile(JSON.stringify({
    providers: {
      custom: {
        baseUrl: "http://localhost:5002/v1",
        models: [{ id: "m", api: "not-a-real-api" }],
      },
    },
  }));
  await withEnv({ LUMISCA_MODELS_FILE: path }, () => {
    assertThrows(
      () => customProvidersFromModelsFile(),
      Error,
      "not-a-real-api",
    );
  });
  await Deno.remove(join(path, ".."), { recursive: true });
});

Deno.test("models.json invalid shape and missing file throw", async () => {
  const path = await writeModelsFile('{"notProviders": {}}');
  await withEnv({ LUMISCA_MODELS_FILE: path }, () => {
    assertThrows(() => customProvidersFromModelsFile(), Error, "providers");
  });
  await Deno.remove(join(path, ".."), { recursive: true });

  await withEnv({ LUMISCA_MODELS_FILE: "C:/nonexistent/models.json" }, () => {
    assertThrows(
      () => customProvidersFromModelsFile(),
      Error,
      "Failed to load",
    );
  });
});

Deno.test("env provider wins id collisions with models.json", async () => {
  const path = await writeModelsFile(JSON.stringify({
    providers: {
      custom: {
        baseUrl: "http://models-json:1/v1",
        models: [{ id: "from-file" }],
      },
      other: {
        baseUrl: "http://other:1/v1",
        models: [{ id: "m" }],
      },
    },
  }));
  await withEnv({
    LUMISCA_MODELS_FILE: path,
    LUMISCA_BASE_URL: "http://env:2/v1",
    LUMISCA_MODEL: "from-env",
  }, () => {
    const core = LumiscaCore.forTesting();
    try {
      // The env provider is registered last: it replaces the models.json
      // entry with the same id.
      const custom = core.listProviders().find((p) =>
        p.id === CUSTOM_PROVIDER_ID
      )!;
      assertEquals(custom.baseUrl, "http://env:2/v1");
      assertEquals(custom.getModels()[0]!.id, "from-env");
      // The other models.json provider survives untouched.
      const other = core.listProviders().find((p) => p.id === "other")!;
      assertEquals(other.getModels()[0]!.baseUrl, "http://other:1/v1");
    } finally {
      core.close();
    }
  });
  await Deno.remove(join(path, ".."), { recursive: true });
});

Deno.test("LumiscaCore.open registers the custom provider from env", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-custom-" });
  const dbPath = join(dir, "test.db");
  const settingsPath = join(dir, "settings.jsonc");
  await withEnv({
    LUMISCA_BASE_URL: "http://localhost:5002/v1",
    LUMISCA_MODEL: "deepseek-chat",
    LUMISCA_API_KEY: "proxy-key",
  }, async () => {
    const core = LumiscaCore.open(dbPath, settingsPath);
    try {
      const model = core.getModel(CUSTOM_PROVIDER_ID, "deepseek-chat");
      assertEquals(model !== undefined, true);
      assertEquals(model!.baseUrl, "http://localhost:5002/v1");
      assertEquals(await core.hasProviderAuth(CUSTOM_PROVIDER_ID), true);

      // A session can be created with the custom provider.
      const ws = await core.createWorkspace("ws", [dir]);
      const session = core.createSession({
        workspaceId: ws.id,
        modelProvider: CUSTOM_PROVIDER_ID,
        modelId: "deepseek-chat",
        headless: true,
      });
      assertEquals(session.modelProvider, CUSTOM_PROVIDER_ID);
      assertEquals(session.modelId, "deepseek-chat");
    } finally {
      core.close();
    }
  });
  await Deno.remove(dir, { recursive: true });
});
