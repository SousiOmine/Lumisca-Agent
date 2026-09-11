import snapshot from "@opencode-ai/models/snapshot";
import type {
  Model as DevModel,
  Provider as DevProvider,
  ProviderMap,
  ReasoningOption,
} from "@opencode-ai/models";
import type {
  Api,
  Model,
  ModelThinkingLevel,
  Provider,
  ThinkingLevelMap,
} from "../ai/types.ts";
import { THINKING_LEVEL_ORDER } from "../shared/providers.ts";
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
 *
 * models.dev's provider-level `npm` names the @ai-sdk/* package a provider's
 * models are served through. Gateways such as OpenCode Go / Zen override it
 * per model to pick the wire protocol: Responses-only models are marked
 * @ai-sdk/openai (POSTed to /v1/responses), Anthropic-shape models
 * @ai-sdk/anthropic (/v1/messages), and the rest stay on the provider's
 * OpenAI-compatible /chat/completions surface. Bundled native packages map
 * to their Lumisca api; anything else is OpenAI-compatible.
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

/** First-party providers with a native @ai-sdk/* package we install. A
 * model-level npm override selects the same transports (OpenCode Go / Zen). */
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
  m: Pick<DevModel, "provider">,
): Api {
  // First-party OpenAI stays on the app's default chat transport unless the
  // metadata explicitly marks the responses shape.
  if (providerId === "openai") {
    return m.provider?.shape === "responses"
      ? "openai-responses"
      : "openai-completions";
  }
  // A model-level npm override wins over its provider's npm: OpenCode Go /
  // Zen serve Responses-only, Anthropic-shape and chat models side by side,
  // and models.dev encodes the per-model SDK there.
  const npm = m.provider?.npm ?? providerNpm;
  const shape = m.provider?.shape;
  switch (npm) {
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google":
    case "@ai-sdk/mistral":
    case "@ai-sdk/azure":
    case "@ai-sdk/amazon-bedrock":
      return NATIVE_AI_SDK.get(npm)!;
    case "@ai-sdk/openai":
      // @ai-sdk/openai drives both APIs; models.dev omits `shape` when the
      // SDK default applies (the Responses API).
      return shape === "completions"
        ? "openai-completions"
        : "openai-responses";
    default:
      // Unbundled / OpenAI-compatible packages (openai-compatible,
      // deepinfra, groq, ...) are chat-completions endpoints.
      return "openai-completions";
  }
}

/** Effort values a `{ type: "effort" }` reasoning option may list, as a
 * map from the models.dev value to the equivalent Lumisca thinking level.
 * "none" is the wire value for "thinking off". */
const EFFORT_LEVEL: Record<string, ModelThinkingLevel> = {
  none: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** Every Lumisca thinking level, as the map's key space (the order does not
 * matter — `getSupportedThinkingLevels` filters the shared order). */
const ALL_LEVELS: readonly ModelThinkingLevel[] = THINKING_LEVEL_ORDER;

/**
 * Derive the per-model `thinkingLevelMap` from models.dev's
 * `reasoning_options`, which list the *exact* set of reasoning values a
 * model accepts:
 * - effort → each listed effort value (including "none" = off) maps to its
 *   Lumisca thinking level;
 * - toggle → off is accepted (the model can switch thinking off);
 * - budget_tokens → a discrete token budget, not a named effort level, so it
 *   contributes nothing.
 * Every level the model does not accept is mapped to `null` (unsupported) so
 * `getSupportedThinkingLevels` returns exactly the accepted set instead of
 * the shared provider defaults. A model with no recognized effort option
 * (no reasoning_options, or only budget_tokens) yields no map, keeping the
 * previous "provider defaults apply" behavior for those.
 */
function thinkingLevelMapFor(options: readonly ReasoningOption[] | undefined):
  | ThinkingLevelMap
  | undefined {
  if (options === undefined || options.length === 0) return undefined;
  const accepted = new Map<ModelThinkingLevel, string>();
  let hasEffort = false;
  for (const option of options) {
    if (option.type === "effort") {
      hasEffort = true;
      for (const value of option.values) {
        // values is ReasoningEffort[], which includes null (disabled).
        if (value === null) {
          accepted.set("off", "none");
          continue;
        }
        const level = EFFORT_LEVEL[value];
        if (level !== undefined) accepted.set(level, value);
      }
    } else if (option.type === "toggle") {
      // "toggle" means thinking can be switched on/off, so off is accepted.
      accepted.set("off", "off");
    }
    // budget_tokens: a token budget, not a named effort — contributes nothing.
  }
  if (!hasEffort) return undefined;
  const map: ThinkingLevelMap = {};
  for (const level of ALL_LEVELS) {
    const wire = accepted.get(level);
    map[level] = wire === undefined ? null : wire;
  }
  return map;
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
    api: apiFor(providerId, providerNpm, m),
    provider: providerId,
    baseUrl: m.provider?.api ?? providerBaseUrl,
    reasoning: m.reasoning,
    input: input.length > 0 ? input : ["text"],
    cost,
    contextWindow: m.limit?.context,
    maxTokens: m.limit?.output,
    headers: m.provider?.headers,
    thinkingLevelMap: thinkingLevelMapFor(m.reasoning_options),
  };
}

/** Build a Lumisca Provider from a models.dev provider (allow-listed).
 * Tolerates upstream field drift: a missing `name` falls back to the
 * provider id, a missing `env` to no env vars (stored credentials still
 * resolve — only ambient env auth is lost for that entry). `npm` stays
 * required for transport selection: without it the provider cannot be
 * routed, so the entry is dropped instead of guessed. */
function toLumiscaProvider(
  id: string,
  p: DevProvider,
): Provider | undefined {
  if (typeof p.npm !== "string" || p.npm.length === 0) return undefined;
  const baseUrl = p.api ?? KNOWN_BASE_URLS[id];
  // Chat models produce text output; image/embedding models do not.
  const models = Object.values(p.models)
    .filter((m) => m.modalities?.output?.includes("text") !== false)
    .map((m) => toLumiscaModel(id, p.npm, baseUrl, m));
  const name = typeof p.name === "string" && p.name.length > 0 ? p.name : id;
  const env = Array.isArray(p.env)
    ? p.env.filter((e): e is string => typeof e === "string")
    : [];
  return buildProvider({
    id,
    name,
    baseUrl,
    auth: envApiKeyAuth(`${name} API key`, env),
    models,
  });
}

/** A single models.dev provider (allow-listed) by id, or undefined.
 * `source` defaults to the bundled snapshot; live/cached catalogs pass
 * their own provider map. */
export function builtinProvider(
  id: string,
  source: ProviderMap = snapshot.providers,
): Provider | undefined {
  const p: DevProvider | undefined = source[id];
  if (p === undefined) return undefined;
  return toLumiscaProvider(id, p);
}

/** Every models.dev provider in the allow-list, freshly constructed. */
export function builtinProviders(
  source: ProviderMap = snapshot.providers,
): Provider[] {
  return buildCatalogProviders(source);
}

/** Build Lumisca providers from a models.dev provider map (live, cached,
 * or the bundled snapshot). Only allow-listed providers are exposed; the
 * mapping (text-output filter, api/transport selection) matches the
 * snapshot path exactly so every source yields the same shapes.
 * Providers without routing metadata (`npm`) are skipped — they cannot be
 * served without guessing the transport. */
export function buildCatalogProviders(source: ProviderMap): Provider[] {
  const out: Provider[] = [];
  for (const id of DEV_PROVIDER_IDS) {
    const p: DevProvider | undefined = source[id];
    if (p === undefined) continue;
    const built = toLumiscaProvider(id, p);
    if (built !== undefined) out.push(built);
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
