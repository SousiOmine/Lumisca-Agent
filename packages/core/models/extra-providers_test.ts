import { assert, assertEquals } from "@std/assert";
import { LumiscaCore } from "../mod.ts";
import {
  builtinProvider,
  builtinProviders,
  clinepassProvider,
  commandcodeProvider,
  deepinfraProvider,
  opencodeGoProvider,
} from "./dev-catalog.ts";
import { getSupportedThinkingLevels } from "./thinking.ts";
import { inputBudgetTokens } from "../shared/context-usage.ts";

/** The providers this suite covers: the ids the catalog must register and
 * the endpoints they must be served from. Written out here instead of
 * imported — an expectation that mirrors a production constant cannot
 * catch that constant drifting. */
const DEEPINFRA_PROVIDER_ID = "deepinfra";
const CLINEPASS_PROVIDER_ID = "cline-pass";
const OPENCODE_GO_PROVIDER_ID = "opencode-go";
const COMMANDCODE_PROVIDER_ID = "commandcode";
const CLINEPASS_BASE_URL = "https://api.cline.bot/api/v1";
/** Every CommandCode plan with API access — all but Go — is served from
 * this one base URL. */
const COMMANDCODE_BASE_URL = "https://api.commandcode.ai/provider/v1";
/** The API key CommandCode's CLI and API share. */
const COMMANDCODE_ENV_VAR = "CMD_API_KEY";
/** OpenCode's gateway publishes one base URL per wire protocol; a model
 * carries the base its transport needs (models.dev's model-level `api`). */
const OPENCODE_GO_BASE_URLS = new Set([
  "https://opencode.ai/inference/go/openai/v1",
  "https://opencode.ai/inference/go/anthropic/v1",
  "https://opencode.ai/inference/go/google/v1beta",
]);

/** The model layer reads its environment through this, so a test never
 * mutates `Deno.env` — the test runner shares ONE process environment
 * across every test file. */
function envOf(vars: Record<string, string>) {
  return () => vars;
}

/** No ambient keys for the extra providers: nothing may look configured
 * just because the machine running the tests has a key exported. */
const NO_ENV = envOf({});

Deno.test("models.dev catalog registers DeepInfra, ClinePass, OpenCode Go and CommandCode", () => {
  const providers = builtinProviders();
  const ids = providers.map((p) => p.id);
  assertEquals(ids.includes(DEEPINFRA_PROVIDER_ID), true);
  assertEquals(ids.includes(CLINEPASS_PROVIDER_ID), true);
  assertEquals(ids.includes(OPENCODE_GO_PROVIDER_ID), true);
  assertEquals(ids.includes(COMMANDCODE_PROVIDER_ID), true);

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

  const commandcode = commandcodeProvider();
  assertEquals(commandcode.id, COMMANDCODE_PROVIDER_ID);
  assertEquals(commandcode.getModels().length > 0, true);
  assertEquals(commandcode.baseUrl, COMMANDCODE_BASE_URL);
  assertEquals(commandcode.auth.apiKey !== undefined, true);
});

Deno.test("OpenCode Go routes each model over the transport models.dev declares", () => {
  const go = opencodeGoProvider();
  const byId = new Map(go.getModels().map((m) => [m.id, m]));

  // Responses-only models (docs: /v1/responses, @ai-sdk/openai) — Muse
  // Spark and friends are rejected when asked over /chat/completions.
  for (
    const id of [
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-contributor",
      "grok-4.7",
      "gpt-5.6-luna",
    ]
  ) {
    assertEquals(
      byId.get(id)?.api,
      "openai-responses",
      `${id} must use the Responses API`,
    );
  }
  // Anthropic-shape models (docs: /v1/messages, @ai-sdk/anthropic).
  for (const id of ["minimax-m3", "qwen3.8-flash"]) {
    assertEquals(byId.get(id)?.api, "anthropic-messages", id);
  }
  // The rest stay on the OpenAI-compatible chat surface
  // (docs: /v1/chat/completions, @ai-sdk/openai-compatible).
  for (const id of ["deepseek-v4.1-flash", "glm-5.3"]) {
    assertEquals(byId.get(id)?.api, "openai-completions", id);
  }
  // The gateway publishes one base URL per wire protocol; each model
  // carries its transport's base and the SDK appends /responses, /messages
  // or /chat/completions to it.
  for (const m of go.getModels()) {
    assertEquals(m.provider, OPENCODE_GO_PROVIDER_ID);
    assertEquals(
      OPENCODE_GO_BASE_URLS.has(m.baseUrl ?? ""),
      true,
      `${m.id} must carry one of the gateway base URLs, got ${m.baseUrl}`,
    );
  }
});

Deno.test("the catalog's input caps stay inside the prompt budget", () => {
  let capped = 0;
  for (const provider of builtinProviders()) {
    for (const model of provider.getModels()) {
      if (model.maxInputTokens === undefined) continue;
      capped++;
      const budget = inputBudgetTokens(model);
      // The budget is the smaller of the two numbers. models.dev publishes
      // one entry that breaks the order (hy3-free: an input cap of 192,000
      // against a 190,000 window), which is exactly why the rule lives in
      // one helper instead of at the call sites.
      assert(
        budget !== undefined && model.contextWindow !== undefined &&
          budget <= model.contextWindow,
        `${provider.id}/${model.id}: budget above the window`,
      );
    }
  }
  // models.dev publishes an input cap for a subset of its models; a catalog
  // that stopped carrying them would leave every budget on the window.
  assert(capped > 0, "no catalog model carries an input cap");
});

Deno.test("OpenCode Zen routes npm-overridden models over their native transport", () => {
  const zen = builtinProvider("opencode")!;
  const byId = new Map(zen.getModels().map((m) => [m.id, m]));
  assertEquals(byId.get("gpt-5.4")?.api, "openai-responses");
  assertEquals(byId.get("claude-sonnet-4-6")?.api, "anthropic-messages");
  assertEquals(byId.get("gemini-3.5-flash")?.api, "google-generative-ai");
  assertEquals(byId.get("deepseek-v4-flash")?.api, "openai-completions");
  // Each transport talks to its own base URL of the gateway.
  assertEquals(
    byId.get("gpt-5.4")?.baseUrl,
    "https://opencode.ai/inference/openai/v1",
  );
  assertEquals(
    byId.get("claude-sonnet-4-6")?.baseUrl,
    "https://opencode.ai/inference/anthropic/v1",
  );
  assertEquals(
    byId.get("gemini-3.5-flash")?.baseUrl,
    "https://opencode.ai/inference/google/v1beta",
  );
});

Deno.test("CommandCode serves Claude over Anthropic messages and the rest over chat", () => {
  const commandcode = commandcodeProvider();
  const byId = new Map(commandcode.getModels().map((m) => [m.id, m]));

  // Claude models answer on /messages only (@ai-sdk/anthropic), with the
  // bare model id; the vendor-prefixed ids (deepseek/…, Qwen/…) stay on
  // the OpenAI-compatible chat surface, which carries them in the body.
  for (const id of ["claude-sonnet-4-6", "claude-opus-4-8"]) {
    assertEquals(byId.get(id)?.api, "anthropic-messages", id);
  }
  for (const id of ["deepseek/deepseek-v4-flash", "Qwen/Qwen3.8-Max"]) {
    assertEquals(byId.get(id)?.api, "openai-completions", id);
  }
  // The gateway rejects a model sent to the other surface (400), so pin the
  // rule for every entry: models.dev encodes it per model as a Claude id on
  // @ai-sdk/anthropic, and everything else on the chat surface. One base URL
  // serves both; the SDK appends /messages or /chat/completions.
  for (const m of commandcode.getModels()) {
    assertEquals(
      m.api,
      m.id.startsWith("claude-") ? "anthropic-messages" : "openai-completions",
      m.id,
    );
    assertEquals(m.provider, COMMANDCODE_PROVIDER_ID);
    assertEquals(m.baseUrl, COMMANDCODE_BASE_URL, m.id);
  }
});

Deno.test("DeepInfra models are OpenAI-compatible with documented fields", () => {
  const models = deepinfraProvider().getModels();
  const byId = new Map(models.map((m) => [m.id, m]));
  // A model pulled from the models.dev catalog.
  const m3 = byId.get("MiniMaxAI/MiniMax-M3")!;
  assertEquals(m3.provider, DEEPINFRA_PROVIDER_ID);
  assertEquals(m3.reasoning, true);
  assertEquals(
    (m3.input ?? []).every((i) => i === "text" || i === "image"),
    true,
  );
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

Deno.test("reasoning models expose the levels models.dev documents", () => {
  const flash = clinepassProvider()
    .getModels()
    .find((m) => m.id === "cline-pass/deepseek-v4-flash")!;
  // models.dev lists its reasoning_options (effort: none/low/high/max),
  // so the model supports exactly those — no minimal/medium/xhigh.
  assertEquals(getSupportedThinkingLevels(flash), [
    "off",
    "low",
    "high",
    "max",
  ]);
});

Deno.test("OpenCode Go models expose distinct per-model thinking levels", () => {
  // Every reasoning model used to collapse to the same provider-default set
  // (off/minimal/low/medium/high) because models.dev's per-model
  // reasoning_options were never mapped into a thinkingLevelMap. Now each
  // model's levels come from its own reasoning_options.
  const go = opencodeGoProvider();
  const levels = (id: string) => {
    const m = go.getModels().find((x) => x.id === id)!;
    return getSupportedThinkingLevels(m);
  };

  // Effort: low/high/max (no minimal/medium, off via "none" absent here).
  assertEquals(levels("deepseek-v4.1-flash"), ["low", "high", "max"]);
  // Effort: minimal/low/medium/high/xhigh (max off; thinking cannot be off).
  assertEquals(levels("muse-spark-1.3-contributor"), [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  // Effort: low/medium/high/xhigh only.
  assertEquals(levels("grok-4.7"), ["low", "medium", "high", "xhigh"]);
  // Effort: only max.
  assertEquals(levels("kimi-k3"), ["max"]);
  // Effort: low/high/max.
  assertEquals(levels("glm-5.3"), ["low", "high", "max"]);

  // At least two of these must actually differ (the original bug made them
  // all identical).
  const sets = new Set([
    JSON.stringify(levels("deepseek-v4.1-flash")),
    JSON.stringify(levels("muse-spark-1.3-contributor")),
    JSON.stringify(levels("grok-4.7")),
    JSON.stringify(levels("kimi-k3")),
  ]);
  assert(sets.size >= 3, "opencode-go models must expose distinct levels");
});

Deno.test("other providers derive per-model levels from reasoning_options", () => {
  // The same mapping applies to every models.dev provider, not just
  // OpenCode Go — verify a representative spread differs per model.
  const openai = builtinProvider("openai")!;
  const openaiLevels = (id: string) => {
    const m = openai.getModels().find((x) => x.id === id)!;
    return getSupportedThinkingLevels(m);
  };
  // gpt-5.2: none/low/medium/high/xhigh.
  assertEquals(openaiLevels("gpt-5.2"), [
    "off",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  // gpt-5-pro: only high.
  assertEquals(openaiLevels("gpt-5-pro"), ["high"]);
  // o3: low/medium/high.
  assertEquals(openaiLevels("o3"), ["low", "medium", "high"]);

  // Anthropic: claude-opus-4-8 effort low/medium/high/xhigh/max.
  const anthropic = builtinProvider("anthropic")!;
  const opus48 = anthropic.getModels().find((m) => m.id === "claude-opus-4-8")!;
  assertEquals(getSupportedThinkingLevels(opus48), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);

  // CommandCode's gateway publishes its own per-model efforts: Claude keeps
  // the Anthropic ladder, and the DeepSeek route takes a narrower one.
  const commandcode = commandcodeProvider();
  const commandcodeLevels = (id: string) => {
    const m = commandcode.getModels().find((x) => x.id === id)!;
    return getSupportedThinkingLevels(m);
  };
  assertEquals(commandcodeLevels("claude-opus-4-8"), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assertEquals(commandcodeLevels("deepseek/deepseek-v4-flash"), [
    "off",
    "low",
    "high",
    "max",
  ]);
});

Deno.test("extra providers register in LumiscaCore and need a stored key", async () => {
  const core = LumiscaCore.forTesting([], NO_ENV);
  try {
    const deepinfra = core.listProviders().find((p) =>
      p.id === DEEPINFRA_PROVIDER_ID
    )!;
    const clinepass = core.listProviders().find((p) =>
      p.id === CLINEPASS_PROVIDER_ID
    )!;
    const commandcode = core.listProviders().find((p) =>
      p.id === COMMANDCODE_PROVIDER_ID
    )!;
    assertEquals(deepinfra.getModels().length > 0, true);
    assertEquals(clinepass.getModels().length > 0, true);
    assertEquals(commandcode.getModels().length > 0, true);

    // Ambient auth must not make them look configured in Lumisca...
    assertEquals(await core.hasConfiguredAuth(DEEPINFRA_PROVIDER_ID), false);
    assertEquals(await core.hasConfiguredAuth(CLINEPASS_PROVIDER_ID), false);
    assertEquals(await core.hasConfiguredAuth(COMMANDCODE_PROVIDER_ID), false);

    // ...but the settings UI offers API-key entry for all of them.
    assertEquals(core.getProviderAuthType(DEEPINFRA_PROVIDER_ID), "api_key");
    assertEquals(core.getProviderAuthType(CLINEPASS_PROVIDER_ID), "api_key");
    assertEquals(
      core.getProviderAuthType(OPENCODE_GO_PROVIDER_ID),
      "api_key",
    );
    assertEquals(core.getProviderAuthType(COMMANDCODE_PROVIDER_ID), "api_key");

    // A stored key is the "configured" signal.
    await core.setProviderApiKey(DEEPINFRA_PROVIDER_ID, "di-key");
    await core.setProviderApiKey(CLINEPASS_PROVIDER_ID, "cp-key");
    await core.setProviderApiKey(COMMANDCODE_PROVIDER_ID, "cc-key");
    assertEquals(await core.hasConfiguredAuth(DEEPINFRA_PROVIDER_ID), true);
    assertEquals(await core.hasConfiguredAuth(CLINEPASS_PROVIDER_ID), true);
    assertEquals(await core.hasConfiguredAuth(COMMANDCODE_PROVIDER_ID), true);
    assertEquals(await core.hasProviderAuth(DEEPINFRA_PROVIDER_ID), true);
    assertEquals(await core.hasProviderAuth(CLINEPASS_PROVIDER_ID), true);
    assertEquals(await core.hasProviderAuth(COMMANDCODE_PROVIDER_ID), true);
  } finally {
    core.close();
  }
});

Deno.test("extra providers resolve their env API keys", async () => {
  const core = LumiscaCore.forTesting(
    [],
    envOf({
      DEEPINFRA_API_KEY: "di-env-key",
      CLINE_API_KEY: "cp-env-key",
      [COMMANDCODE_ENV_VAR]: "cc-env-key",
    }),
  );
  try {
    assertEquals(await core.hasProviderAuth(DEEPINFRA_PROVIDER_ID), true);
    assertEquals(await core.hasProviderAuth(CLINEPASS_PROVIDER_ID), true);
    const di = await core.checkAuth(DEEPINFRA_PROVIDER_ID);
    assertEquals(di?.source, "DEEPINFRA_API_KEY");
    const cp = await core.checkAuth(CLINEPASS_PROVIDER_ID);
    assertEquals(cp?.source, "CLINE_API_KEY");
    // CommandCode names its key CMD_API_KEY (the CLI and the Provider API
    // share one key, whatever the plan).
    assertEquals(await core.hasProviderAuth(COMMANDCODE_PROVIDER_ID), true);
    const cc = await core.checkAuth(COMMANDCODE_PROVIDER_ID);
    assertEquals(cc?.source, COMMANDCODE_ENV_VAR);
  } finally {
    core.close();
  }
});

// (completions compat narrowing is exercised in the DeepInfra/ClinePass
// shape tests above; models.dev models do not carry a compat map.)
