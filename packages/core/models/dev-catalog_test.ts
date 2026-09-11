import { assert, assertEquals } from "@std/assert";
import type { ProviderMap } from "@opencode-ai/models";
import snapshot from "@opencode-ai/models/snapshot";
import {
  buildCatalogProviders,
  builtinProvider,
  DEV_PROVIDER_IDS,
} from "./dev-catalog.ts";

/** A models.dev catalog holding the given openai models, so the catalog
 * builder's model selection can be exercised without the snapshot. Only
 * the fields under test are spelled out; the rest (name, limits, dates)
 * are filled in as `isProviderMap`/`toLumiscaModel` expect them. */
function catalogWith(
  models: Array<{ id: string } & Record<string, unknown>>,
): ProviderMap {
  return {
    openai: {
      id: "openai",
      env: ["OPENAI_API_KEY"],
      npm: "@ai-sdk/openai",
      name: "OpenAI",
      doc: "https://example.test/openai",
      models: Object.fromEntries(
        models.map(({ id, ...overrides }) => [
          id,
          {
            id,
            name: id,
            description: "",
            attachment: false,
            reasoning: false,
            release_date: "2026-01-01",
            last_updated: "2026-01-01",
            modalities: { input: ["text"], output: ["text"] },
            open_weights: false,
            limit: { context: 1000, output: 100 },
            ...overrides,
          },
        ]),
      ),
    },
  } as unknown as ProviderMap;
}

function listedModels(
  models: Array<{ id: string } & Record<string, unknown>>,
): string[] {
  const built = buildCatalogProviders(catalogWith(models));
  assertEquals(built.map((p) => p.id), ["openai"]);
  return built[0]!.getModels().map((m) => m.id);
}

Deno.test("catalog lists only models that support tool calling", () => {
  assertEquals(
    listedModels([
      { id: "agent", tool_call: true },
      {
        id: "agent-unspecified-output",
        tool_call: true,
        modalities: undefined,
      },
      { id: "embedding", tool_call: false },
      { id: "tool-call-unset" },
      {
        id: "tool-call-false-no-modalities",
        tool_call: false,
        modalities: undefined,
      },
    ]),
    ["agent", "agent-unspecified-output"],
  );
});

Deno.test("catalog still drops models that cannot answer in text", () => {
  assertEquals(
    listedModels([
      { id: "agent", tool_call: true },
      {
        id: "image-generator",
        tool_call: true,
        modalities: { input: ["text"], output: ["image"] },
      },
      {
        id: "audio-only",
        tool_call: true,
        modalities: { input: ["audio"], output: [] },
      },
    ]),
    ["agent"],
  );
});

Deno.test("every listed snapshot model declares tool calling", () => {
  for (const id of DEV_PROVIDER_IDS) {
    const source = snapshot.providers[id];
    const provider = builtinProvider(id);
    if (source === undefined || provider === undefined) continue;
    const models = provider.getModels();
    assert(models.length > 0, `provider exposed no model: ${id}`);
    for (const model of models) {
      assertEquals(
        source.models[model.id]?.tool_call,
        true,
        `${id}/${model.id} must declare tool calling`,
      );
      assert(
        source.models[model.id]?.modalities?.output?.includes("text") !== false,
        `${id}/${model.id} must not be known to lack text output`,
      );
    }
  }
});

Deno.test("snapshot hides embeddings, transcription and image models", () => {
  const ids = (providerId: string) =>
    builtinProvider(providerId)!.getModels().map((m) => m.id);

  // Non-agent models the pickers used to offer.
  assertEquals(ids("openai").includes("text-embedding-3-small"), false);
  assertEquals(ids("openai").includes("text-embedding-ada-002"), false);
  assertEquals(ids("mistral").includes("mistral-embed"), false);
  assertEquals(ids("groq").includes("whisper-large-v3"), false);

  // The agent models the pickers rely on stay.
  for (const id of ["gpt-5.2", "gpt-5-pro", "o3"]) {
    assertEquals(ids("openai").includes(id), true, id);
  }
  assertEquals(ids("anthropic").includes("claude-opus-4-8"), true);
});
