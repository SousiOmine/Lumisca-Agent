import snapshot from "@opencode-ai/models/snapshot";
import type {
  Model as DevModel,
  Provider as DevProvider,
} from "@opencode-ai/models";
import type { Api, Model, Provider } from "../ai/types.ts";
import { buildProvider, envApiKeyAuth } from "./custom.ts";

/**
 * The built-in provider/model catalog, derived from models.dev (the
 * upstream metadata source, exposed by @opencode-ai/models) rather than
 * hand-curated here. This module only maps models.dev's metadata onto
 * Lumisca's Provider/Model shapes — the actual LLM calls go through the
 * Vercel AI SDK (see ai/lang-model.ts), which the app owns.
 *
 * The allow-list keeps the model picker focused; models.dev still supplies
 * every provider/model's ids, names, limits, modalities and reasoning flag.
 * Providers whose npm package is not bundled fall back to the
 * @ai-sdk/openai-compatible transport (they are OpenAI-compatible).
 */

/** Providers exposed in the Lumisca picker. Edit to widen/narrow. */
export const DEV_PROVIDER_IDS: readonly string[] = [
  "openai",
  "anthropic",
  "google",
  "mistral",
  "deepinfra",
  "opencode",
  "opencode-go",
  "cline-pass",
  "deepseek",
  "groq",
  "xai",
  "cerebras",
  "huggingface",
];

/** First-party providers with a native @ai-sdk/* package we install. */
const NATIVE_AI_SDK = new Map<string, Api>([
  ["@ai-sdk/anthropic", "anthropic-messages"],
  ["@ai-sdk/google", "google-generative-ai"],
  ["@ai-sdk/mistral", "mistral-conversations"],
  ["@ai-sdk/azure", "azure-openai-responses"],
  ["@ai-sdk/amazon-bedrock", "bedrock-converse-stream"],
]);

/** Base URLs for OpenAI-compatible providers whose models.dev entry does not
 * publish an `api` (they are served by native @ai-sdk packages that hardcode
 * the endpoint; the compatible transport needs it explicitly). */
const KNOWN_BASE_URLS: Record<string, string> = {
  deepinfra: "https://api.deepinfra.com/v1/openai",
  deepseek: "https://api.deepseek.com",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
};

/** Map a models.dev provider/model to a Lumisca api string. */
function apiFor(
  providerId: string,
  providerNpm: string,
  shape: string | undefined,
): Api {
  if (providerId === "openai") {
    return shape === "responses" ? "openai-responses" : "openai-completions";
  }
  const native = NATIVE_AI_SDK.get(providerNpm);
  if (native !== undefined) return native;
  // Everything else is OpenAI-compatible (or a bundled-native openai).
  return shape === "responses" ? "openai-responses" : "openai-completions";
}

/** Build a Lumisca Model from a models.dev Model entry. */
function toLumiscaModel(
  providerId: string,
  providerNpm: string,
  providerBaseUrl: string | undefined,
  m: DevModel,
): Model<Api> {
  const input = (m.modalities?.input ?? [])
    .filter((i): i is "text" | "image" => i === "text" || i === "image");
  const cost = m.cost !== undefined && typeof m.cost === "object"
    ? {
      input: m.cost.input ?? 0,
      output: m.cost.output ?? 0,
      cacheRead: (m.cost as { cache_read?: number }).cache_read ?? 0,
      cacheWrite: (m.cost as { cache_write?: number }).cache_write ?? 0,
    }
    : undefined;
  return {
    id: m.id,
    name: m.name,
    api: apiFor(providerId, providerNpm, m.provider?.shape),
    provider: providerId,
    baseUrl: m.provider?.api ?? providerBaseUrl,
    reasoning: m.reasoning,
    input: input.length > 0 ? input : ["text"],
    cost,
    contextWindow: m.limit?.context,
    maxTokens: m.limit?.output,
    headers: m.provider?.headers,
  };
}

/** Build a Lumisca Provider from a models.dev provider (allow-listed). */
function toLumiscaProvider(
  id: string,
  p: DevProvider,
): Provider {
  const baseUrl = p.api ?? KNOWN_BASE_URLS[id];
  // Chat models produce text output; image/embedding models do not.
  const models = Object.values(p.models)
    .filter((m) => m.modalities?.output?.includes("text") !== false)
    .map((m) => toLumiscaModel(id, p.npm, baseUrl, m));
  return buildProvider({
    id,
    name: p.name,
    baseUrl,
    auth: envApiKeyAuth(`${p.name} API key`, p.env),
    models,
  });
}

/** A single models.dev provider (allow-listed) by id, or undefined. */
export function builtinProvider(id: string): Provider | undefined {
  const p = snapshot.providers[id];
  if (p === undefined) return undefined;
  return toLumiscaProvider(id, p);
}

/** Every models.dev provider in the allow-list, freshly constructed. */
export function builtinProviders(): Provider[] {
  const out: Provider[] = [];
  for (const id of DEV_PROVIDER_IDS) {
    const p = snapshot.providers[id];
    if (p === undefined) continue;
    out.push(toLumiscaProvider(id, p));
  }
  return out;
}

/** DeepInfra (OpenAI-compatible marketplace) from models.dev. */
export function deepinfraProvider(): Provider {
  return builtinProvider("deepinfra")!;
}

/** ClinePass (Cline subscription, OpenAI-compatible) from models.dev. */
export function clinepassProvider(): Provider {
  return builtinProvider("cline-pass")!;
}

/** OpenCode Go from models.dev. */
export function opencodeGoProvider(): Provider {
  return builtinProvider("opencode-go")!;
}

/** The number of models.dev providers exposed (for tests/UI). */
export function devProviderCount(): number {
  return DEV_PROVIDER_IDS.reduce(
    (n, id) => n + (snapshot.providers[id] !== undefined ? 1 : 0),
    0,
  );
}
