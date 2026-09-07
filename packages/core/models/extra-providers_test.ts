import { assertEquals } from "@std/assert";
import { LumiscaCore } from "../mod.ts";
import {
  builtinProviders,
  clinepassProvider,
  deepinfraProvider,
  opencodeGoProvider,
} from "./dev-catalog.ts";
import {
  CLINEPASS_BASE_URL,
  CLINEPASS_PROVIDER_ID,
  DEEPINFRA_PROVIDER_ID,
  OPENCODE_GO_PROVIDER_ID,
} from "./extra-providers.ts";
import { getSupportedThinkingLevels } from "./thinking.ts";

const ENV_KEYS = ["DEEPINFRA_API_KEY", "CLINE_API_KEY", "OPENCODE_API_KEY"];

/** Run `body` with a clean env for the extra providers, then restore it. */
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

Deno.test("models.dev catalog registers DeepInfra, ClinePass and OpenCode Go", () => {
  const providers = builtinProviders();
  const ids = providers.map((p) => p.id);
  assertEquals(ids.includes(DEEPINFRA_PROVIDER_ID), true);
  assertEquals(ids.includes(CLINEPASS_PROVIDER_ID), true);
  assertEquals(ids.includes(OPENCODE_GO_PROVIDER_ID), true);

  const deepinfra = deepinfraProvider();
  assertEquals(deepinfra.id, "deepinfra");
  assertEquals(deepinfra.getModels().length > 0, true);
  assertEquals(deepinfra.auth.apiKey !== undefined, true);

  const clinepass = clinepassProvider();
  assertEquals(clinepass.id, "cline-pass");
  assertEquals(clinepass.getModels().length > 0, true);
  assertEquals(clinepass.baseUrl, CLINEPASS_BASE_URL);
  assertEquals(clinepass.auth.apiKey !== undefined, true);

  const opencodeGo = opencodeGoProvider();
  assertEquals(opencodeGo.id, "opencode-go");
  assertEquals(opencodeGo.getModels().length > 0, true);
  assertEquals(opencodeGo.auth.apiKey !== undefined, true);
});

Deno.test("DeepInfra models are OpenAI-compatible with documented fields", () => {
  const models = deepinfraProvider().getModels();
  const byId = new Map(models.map((m) => [m.id, m]));
  // A model pulled from the models.dev catalog.
  const m3 = byId.get("MiniMaxAI/MiniMax-M3")!;
  assertEquals(m3.provider, DEEPINFRA_PROVIDER_ID);
  assertEquals(m3.reasoning, true);
  assertEquals((m3.input ?? []).every((i) => i === "text" || i === "image"), true);
});

Deno.test("ClinePass models use the cline-pass slug", () => {
  const models = clinepassProvider().getModels();
  for (const model of models) {
    assertEquals(model.id.startsWith("cline-pass/"), true);
    assertEquals(model.provider, CLINEPASS_PROVIDER_ID);
    assertEquals(model.baseUrl, CLINEPASS_BASE_URL);
  }
  const ids = models.map((m) => m.id);
  assertEquals(ids.includes("cline-pass/deepseek-v4-flash"), true);
});

Deno.test("reasoning models expose the default thinking levels", () => {
  const flash = clinepassProvider()
    .getModels()
    .find((m) => m.id === "cline-pass/deepseek-v4-flash")!;
  // models.dev marks it as a reasoning model; without a provider-specific
  // thinking map the SDK defaults apply (off..high).
  assertEquals(getSupportedThinkingLevels(flash)[0], "off");
  assertEquals(getSupportedThinkingLevels(flash).includes("high"), true);
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
      assertEquals(deepinfra.getModels().length > 0, true);
      assertEquals(clinepass.getModels().length > 0, true);

      // Ambient auth must not make them look configured in Lumisca...
      assertEquals(await core.hasConfiguredAuth(DEEPINFRA_PROVIDER_ID), false);
      assertEquals(await core.hasConfiguredAuth(CLINEPASS_PROVIDER_ID), false);

      // ...but the settings UI offers API-key entry for all three.
      assertEquals(core.getProviderAuthType(DEEPINFRA_PROVIDER_ID), "api_key");
      assertEquals(core.getProviderAuthType(CLINEPASS_PROVIDER_ID), "api_key");
      assertEquals(
        core.getProviderAuthType(OPENCODE_GO_PROVIDER_ID),
        "api_key",
      );

      // A stored key is the "configured" signal.
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

// (completions compat narrowing is exercised in the DeepInfra/ClinePass
// shape tests above; models.dev models do not carry a compat map.)
