import { assertEquals } from "@std/assert";
import type {
  Api,
  Model,
  OpenAICompletionsCompat,
} from "@earendil-works/pi-ai";
import { LumiscaCore } from "../mod.ts";
import {
  CLINEPASS_BASE_URL,
  CLINEPASS_PROVIDER_ID,
  clinepassProvider,
  DEEPINFRA_BASE_URL,
  DEEPINFRA_PROVIDER_ID,
  deepinfraProvider,
  extraProviders,
} from "./extra-providers.ts";
import { getSupportedThinkingLevels } from "./thinking.ts";

/** The OpenAI-completions compat of a model (every extra-provider model
 * uses that api; the union narrowing keeps the access type-safe). */
function completionsCompat(
  model: Model<Api>,
): OpenAICompletionsCompat | undefined {
  return model.api === "openai-completions" ? model.compat : undefined;
}

const ENV_KEYS = ["DEEPINFRA_API_KEY", "CLINE_API_KEY"];

/** Run `body` with a clean env for the extra providers, then restore it
 * (deno test runs files in parallel processes; ambient keys would make
 * hasProviderAuth pass spuriously). */
async function withCleanEnv(
  body: () => void | Promise<void>,
): Promise<void> {
  const saved = new Map(ENV_KEYS.map((k) => [k, Deno.env.get(k)]));
  for (const k of ENV_KEYS) Deno.env.delete(k);
  try {
    await body();
  } finally {
    for (const k of ENV_KEYS) Deno.env.delete(k);
    for (const [k, v] of saved) {
      if (v !== undefined) Deno.env.set(k, v);
    }
  }
}

Deno.test("extraProviders registers DeepInfra and ClinePass", () => {
  const providers = extraProviders();
  assertEquals(providers.map((p) => p.id), [
    DEEPINFRA_PROVIDER_ID,
    CLINEPASS_PROVIDER_ID,
  ]);

  const deepinfra = deepinfraProvider();
  assertEquals(deepinfra.id, "deepinfra");
  assertEquals(deepinfra.name, "DeepInfra");
  assertEquals(deepinfra.baseUrl, DEEPINFRA_BASE_URL);
  assertEquals(deepinfra.getModels().length, 62);
  // API key entry in the settings UI.
  assertEquals(deepinfra.auth.apiKey !== undefined, true);

  const clinepass = clinepassProvider();
  assertEquals(clinepass.id, "clinepass");
  assertEquals(clinepass.name, "ClinePass");
  assertEquals(clinepass.baseUrl, CLINEPASS_BASE_URL);
  assertEquals(clinepass.getModels().length, 13);
  assertEquals(clinepass.auth.apiKey !== undefined, true);
});

Deno.test("DeepInfra models are OpenAI-compatible with documented fields", () => {
  const models = deepinfraProvider().getModels();
  // A reasoning flagship and a plain instruct model spot-check the shape.
  const byId = new Map(models.map((m) => [m.id, m]));
  const v4Pro = byId.get("deepseek-ai/DeepSeek-V4-Pro")!;
  assertEquals(v4Pro.api, "openai-completions");
  assertEquals(v4Pro.provider, DEEPINFRA_PROVIDER_ID);
  assertEquals(v4Pro.baseUrl, DEEPINFRA_BASE_URL);
  assertEquals(v4Pro.reasoning, true);
  assertEquals(v4Pro.contextWindow, 1_048_576);
  assertEquals(v4Pro.maxTokens, 16_384);
  assertEquals(completionsCompat(v4Pro)?.maxTokensField, "max_tokens");

  const llama = byId.get("meta-llama/Llama-3.3-70B-Instruct-Turbo")!;
  assertEquals(llama.reasoning, false);

  // Vision-capable models keep exactly the text/image input pi-ai models.
  for (const model of models) {
    assertEquals(
      model.input.every((i) => i === "text" || i === "image"),
      true,
    );
  }
});

Deno.test("ClinePass models use the cline-pass slug and system role", () => {
  const models = clinepassProvider().getModels();
  for (const model of models) {
    // Cline's API requires the full "cline-pass/<model>" slug and rejects
    // the developer role; every model must declare both.
    assertEquals(model.id.startsWith("cline-pass/"), true);
    assertEquals(completionsCompat(model)?.supportsDeveloperRole, false);
    assertEquals(model.api, "openai-completions");
    assertEquals(model.provider, CLINEPASS_PROVIDER_ID);
    assertEquals(model.baseUrl, CLINEPASS_BASE_URL);
    assertEquals(model.reasoning, true);
  }
  const ids = models.map((m) => m.id);
  assertEquals(ids.includes("cline-pass/glm-5.3"), true);
  assertEquals(ids.includes("cline-pass/deepseek-v4-flash"), true);
  assertEquals(ids.includes("cline-pass/qwen3.8-max"), true);
});

Deno.test("ClinePass thinking levels reflect each model's effort enum", () => {
  const models = new Map(
    clinepassProvider().getModels().map((m) => [m.id, m]),
  );

  // deepseek-v4-flash: reasoning_effort only accepts none/high.
  const flash = models.get("cline-pass/deepseek-v4-flash")!;
  assertEquals(getSupportedThinkingLevels(flash), ["off", "high", "xhigh"]);

  // glm-5.3 always reasons (enum low/high/max): off is unsupported, xhigh
  // maps to max.
  const glm53 = models.get("cline-pass/glm-5.3")!;
  assertEquals(getSupportedThinkingLevels(glm53), ["low", "high", "xhigh"]);

  // kimi-k3 only accepts effort "max": exactly one level is supported.
  const k3 = models.get("cline-pass/kimi-k3")!;
  assertEquals(getSupportedThinkingLevels(k3), ["high"]);
});

Deno.test("extra providers register in LumiscaCore and need a stored key", async () => {
  await withCleanEnv(async () => {
    const core = LumiscaCore.forTesting();
    try {
      const deepinfra = core.listProviders().find((p) =>
        p.id === DEEPINFRA_PROVIDER_ID
      )!;
      const clinepass = core.listProviders().find((p) =>
        p.id === CLINEPASS_PROVIDER_ID
      )!;
      assertEquals(deepinfra.getModels().length, 62);
      assertEquals(clinepass.getModels().length, 13);

      // Ambient auth must not make them look configured in Lumisca...
      assertEquals(await core.hasConfiguredAuth(DEEPINFRA_PROVIDER_ID), false);
      assertEquals(await core.hasConfiguredAuth(CLINEPASS_PROVIDER_ID), false);

      // ...but the settings UI offers API-key entry for both.
      assertEquals(core.getProviderAuthType(DEEPINFRA_PROVIDER_ID), "api_key");
      assertEquals(core.getProviderAuthType(CLINEPASS_PROVIDER_ID), "api_key");

      // A stored key is the "configured" signal (same as the SDK builtins).
      await core.setProviderApiKey(DEEPINFRA_PROVIDER_ID, "di-key");
      await core.setProviderApiKey(CLINEPASS_PROVIDER_ID, "cp-key");
      assertEquals(await core.hasConfiguredAuth(DEEPINFRA_PROVIDER_ID), true);
      assertEquals(await core.hasConfiguredAuth(CLINEPASS_PROVIDER_ID), true);
      assertEquals(await core.hasProviderAuth(DEEPINFRA_PROVIDER_ID), true);
      assertEquals(await core.hasProviderAuth(CLINEPASS_PROVIDER_ID), true);
    } finally {
      core.close();
    }
  });
});

Deno.test("extra providers resolve their env API keys", async () => {
  Deno.env.set("DEEPINFRA_API_KEY", "di-env-key");
  Deno.env.set("CLINE_API_KEY", "cp-env-key");
  try {
    const core = LumiscaCore.forTesting();
    try {
      assertEquals(await core.hasProviderAuth(DEEPINFRA_PROVIDER_ID), true);
      assertEquals(await core.hasProviderAuth(CLINEPASS_PROVIDER_ID), true);
      const di = await core.checkAuth(DEEPINFRA_PROVIDER_ID);
      assertEquals(di?.source, "DEEPINFRA_API_KEY");
      const cp = await core.checkAuth(CLINEPASS_PROVIDER_ID);
      assertEquals(cp?.source, "CLINE_API_KEY");
    } finally {
      core.close();
    }
  } finally {
    Deno.env.delete("DEEPINFRA_API_KEY");
    Deno.env.delete("CLINE_API_KEY");
  }
});
