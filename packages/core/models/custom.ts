import {
  type Api,
  type ApiKeyAuth,
  createProvider,
  envApiKeyAuth,
  type Model,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";

/**
 * Custom OpenAI-compatible providers for headless/agent use.
 *
 * Two registration sources, both read once at ModelManager construction:
 *
 * 1. Environment variables (the simplest path, used by the distill-gym
 *    harness integration which injects the proxy URL as env vars):
 *    - LUMISCA_BASE_URL  — base URL of the OpenAI-compatible endpoint
 *    - LUMISCA_MODEL     — model id to register under the provider
 *    - LUMISCA_API_KEY   — API key (falls back to OPENAI_API_KEY)
 *
 * 2. A models.json file (pi-coding-agent compatible subset), whose path is
 *    given by LUMISCA_MODELS_FILE. Multiple providers with several models
 *    each can be defined there.
 *
 * Both sources may be active at once; the env-var provider is registered
 * last so it wins on provider-id collisions (setProvider is an upsert).
 */

/** Provider id of the env-var custom provider. */
export const CUSTOM_PROVIDER_ID = "custom";

/** Defaults matching pi-coding-agent's modelFromJson (models.json). */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** The models.json shape lumisca reads (a subset of pi-coding-agent's
 * schema: no modelOverrides / oauth / compat). */
interface ModelsFileProvider {
  name?: string;
  baseUrl?: string;
  /** Literal key, or "${ENV_VAR_NAME}" to resolve from the environment. */
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  models?: ModelsFileModel[];
}

interface ModelsFileModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

interface ModelsFileConfig {
  providers: Record<string, ModelsFileProvider>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelsFileConfig(value: unknown): value is ModelsFileConfig {
  return isRecord(value) && isRecord(value.providers);
}

/** Auth that always resolves to a fixed literal key (models.json apiKey). */
function fixedKeyAuth(key: string): ApiKeyAuth {
  return {
    name: "API key",
    login: async (interaction) => {
      interaction.signal.throwIfAborted();
      const entered = await interaction.prompt({
        type: "secret",
        message: "Enter API key",
      });
      return { type: "api_key", key: entered };
    },
    resolve: () =>
      Promise.resolve({ auth: { apiKey: key }, source: "models.json" }),
  };
}

/** Resolve the ApiKeyAuth for a models.json provider entry:
 * "${ENV}" → that env var, a literal string → fixed key, unset → the
 * LUMISCA_API_KEY_<ID> env var (then LUMISCA_API_KEY). */
function modelsFileApiKey(
  providerId: string,
  apiKey: string | undefined,
): ApiKeyAuth {
  if (apiKey === undefined) {
    return envApiKeyAuth(`API key for ${providerId}`, [
      `LUMISCA_API_KEY_${providerId.toUpperCase()}`,
      "LUMISCA_API_KEY",
    ]);
  }
  const envMatch = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(apiKey);
  if (envMatch) {
    return envApiKeyAuth(`API key for ${providerId}`, [envMatch[1]!]);
  }
  return fixedKeyAuth(apiKey);
}

function buildModel(
  providerId: string,
  definition: ModelsFileModel,
  providerCfg: {
    baseUrl?: string;
    api?: string;
    headers?: Record<string, string>;
  },
): Model<Api> {
  const api = definition.api ?? providerCfg.api ?? "openai-completions";
  const baseUrl = definition.baseUrl ?? providerCfg.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `models.json provider "${providerId}": "baseUrl" is required ` +
        `(set it on the provider or on model "${definition.id}")`,
    );
  }
  if (getApiProvider(api) === undefined) {
    throw new Error(
      `models.json provider "${providerId}": unsupported api "${api}" ` +
        `(model "${definition.id}")`,
    );
  }
  if (
    definition.contextWindow !== undefined &&
    definition.contextWindow <= 0
  ) {
    throw new Error(
      `models.json provider "${providerId}", model "${definition.id}": ` +
        "invalid contextWindow",
    );
  }
  if (definition.maxTokens !== undefined && definition.maxTokens <= 0) {
    throw new Error(
      `models.json provider "${providerId}", model "${definition.id}": ` +
        "invalid maxTokens",
    );
  }
  return {
    id: definition.id,
    name: definition.name ?? definition.id,
    api: api as Api,
    provider: providerId,
    baseUrl,
    reasoning: definition.reasoning ?? false,
    input: definition.input ?? ["text"],
    cost: definition.cost ?? DEFAULT_COST,
    contextWindow: definition.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: definition.maxTokens ?? DEFAULT_MAX_TOKENS,
    // pi-ai sends model.headers (merged into the auth headers by
    // Models.applyAuth); provider-level headers alone would be ignored,
    // so they are propagated onto every model of the provider.
    headers: providerCfg.headers,
  };
}

/** Build a Provider from resolved parts (shared by both sources). */
function buildProvider(input: {
  id: string;
  name: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  auth: ApiKeyAuth;
  models: Model<Api>[];
}): Provider {
  // The api map covers every api used by the models; getApiProvider has
  // already validated the names (see buildModel).
  const apiMap: Record<string, ProviderStreams> = {};
  for (const model of input.models) {
    apiMap[model.api] = getApiProvider(model.api)!;
  }
  return createProvider({
    id: input.id,
    name: input.name,
    baseUrl: input.baseUrl,
    headers: input.headers,
    auth: { apiKey: input.auth },
    models: input.models,
    api: apiMap as Partial<Record<Api, ProviderStreams>>,
  });
}

/** The env-var custom provider, or undefined when LUMISCA_BASE_URL is not
 * set. Throws on a partial configuration (base URL without a model). */
export function customProviderFromEnv(): Provider | undefined {
  const baseUrl = Deno.env.get("LUMISCA_BASE_URL");
  if (!baseUrl) return undefined;
  const modelId = Deno.env.get("LUMISCA_MODEL");
  if (!modelId) {
    throw new Error(
      "LUMISCA_BASE_URL is set but LUMISCA_MODEL is missing; " +
        "set LUMISCA_MODEL to the model id the endpoint serves",
    );
  }
  return buildProvider({
    id: CUSTOM_PROVIDER_ID,
    name: "Custom (OpenAI-compatible)",
    baseUrl,
    auth: envApiKeyAuth("Custom API key", [
      "LUMISCA_API_KEY",
      "OPENAI_API_KEY",
    ]),
    models: [{
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: CUSTOM_PROVIDER_ID,
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: DEFAULT_COST,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    }],
  });
}

/** Providers defined in the models.json file pointed to by
 * LUMISCA_MODELS_FILE (empty when the env var is unset). Throws on a
 * missing/unreadable/invalid file — a configured file must be correct. */
export function customProvidersFromModelsFile(): Provider[] {
  const path = Deno.env.get("LUMISCA_MODELS_FILE");
  if (!path) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(Deno.readTextFileSync(path));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load models.json: ${detail}\nFile: ${path}`);
  }
  if (!isModelsFileConfig(parsed)) {
    throw new Error(
      `Invalid models.json: expected {"providers": {...}}\nFile: ${path}`,
    );
  }

  const providers: Provider[] = [];
  for (const [providerId, cfg] of Object.entries(parsed.providers)) {
    const models = (cfg.models ?? []).map((definition) =>
      buildModel(providerId, definition, cfg)
    );
    if (models.length === 0) {
      throw new Error(
        `models.json provider "${providerId}": at least one model is required`,
      );
    }
    providers.push(
      buildProvider({
        id: providerId,
        name: cfg.name ?? providerId,
        baseUrl: cfg.baseUrl,
        headers: cfg.headers,
        auth: modelsFileApiKey(providerId, cfg.apiKey),
        models,
      }),
    );
  }
  return providers;
}

/** Every custom provider: models.json first, then the env-var provider
 * (registered last so it wins id collisions). */
export function loadCustomProviders(): Provider[] {
  return [
    ...customProvidersFromModelsFile(),
    ...(customProviderFromEnv() !== undefined
      ? [customProviderFromEnv()!]
      : []),
  ];
}
