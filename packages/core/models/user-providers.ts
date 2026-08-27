import type {
  ApiKeyAuth,
  CredentialStore,
  Provider,
} from "@earendil-works/pi-ai";
import type { SettingsRepo } from "../settings/repo.ts";
import { CoreError } from "../errors.ts";
import { buildModel, buildProvider } from "./custom.ts";

/**
 * User-defined OpenAI-compatible providers, added from the settings UI
 * (and the CLI). Unlike the headless env-var / models.json custom
 * providers (custom.ts), these live in the Lumisca settings store and can
 * be created, edited and removed at runtime — the "add as many OpenAI-
 * compatible providers as you like" feature.
 *
 * The API key is never stored alongside the config: it goes through the
 * credential store (the same place `setProviderApiKey` writes), keyed by
 * provider id. The provider's ApiKeyAuth resolves it from there, so the
 * existing auth / configured checks apply unchanged.
 */

/** Settings-table key holding the array of user provider configs. */
export const USER_PROVIDERS_KEY = "user_providers";

/** APIs a user-defined OpenAI-compatible provider may use. Restricted to
 * the OpenAI-compatible surface (not the proprietary Anthropic / Google /
 * AWS protocols) so the endpoint contract the user is configuring actually
 * matches what pi-ai will send. */
export const ALLOWED_OPENAI_APIS = [
  "openai-completions",
  "openai-responses",
] as const;

type AllowedApi = (typeof ALLOWED_OPENAI_APIS)[number];

/** One model of a user-defined provider. A structural subset of the
 * models.json model shape (custom.ts::buildModel accepts it directly). */
export interface UserProviderModel {
  id: string;
  name?: string;
  /** Override the provider's default api for this model. */
  api?: string;
  /** Override the provider's base URL for this model. */
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

/** The persisted shape of a user-defined provider (no secret). */
export interface UserProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  /** Default api for models that do not override it. */
  api: string;
  headers?: Record<string, string>;
  models: UserProviderModel[];
}

/** What the client sends when creating/updating. The optional `apiKey` is
 * persisted to the credential store, never echoed back. */
export interface UserProviderInput extends UserProviderConfig {
  apiKey?: string;
}

/** What the server returns for listing/editing. `hasApiKey` lets the UI
 * show whether auth is set without exposing the key. */
export interface UserProviderSummary extends UserProviderConfig {
  hasApiKey: boolean;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedApi(value: unknown): value is AllowedApi {
  return typeof value === "string" &&
    (ALLOWED_OPENAI_APIS as readonly string[]).includes(value);
}

function isHeaders(value: unknown): value is Record<string, string> {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

function isModelInput(value: unknown): value is ("text" | "image")[] {
  return Array.isArray(value) &&
    value.every((v) => v === "text" || v === "image");
}

function isCost(value: unknown): value is UserProviderModel["cost"] {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return ["input", "output", "cacheRead", "cacheWrite"].every(
    (k) => typeof value[k] === "number",
  );
}

/**
 * Validate and normalize raw client input into a persisted config plus an
 * optional API key. Throws `CoreError("invalid")` on any malformed field,
 * so the HTTP layer maps it to 400. The `id` field of `input` is ignored
 * for updates (the route fixes it); for creates it is required.
 */
export function parseUserProviderInput(
  raw: unknown,
  opts: { requireId?: boolean } = {},
): UserProviderInput {
  if (!isRecord(raw)) {
    throw new CoreError("provider config must be an object", "invalid");
  }
  const id = raw.id;
  if (opts.requireId) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      throw new CoreError(`invalid provider id: ${String(id)}`, "invalid");
    }
  } else if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new CoreError(
      "provider id is required and must match [A-Za-z0-9][A-Za-z0-9._-]*",
      "invalid",
    );
  }

  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new CoreError("provider name is required", "invalid");
  }

  const baseUrl = raw.baseUrl;
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new CoreError("baseUrl is required", "invalid");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new CoreError(`invalid baseUrl: ${baseUrl}`, "invalid");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new CoreError(
      `baseUrl must be http(s): ${baseUrl}`,
      "invalid",
    );
  }

  if (!isAllowedApi(raw.api)) {
    throw new CoreError(
      `api must be one of ${ALLOWED_OPENAI_APIS.join(", ")}`,
      "invalid",
    );
  }

  if (!isHeaders(raw.headers)) {
    throw new CoreError("headers must be an object of strings", "invalid");
  }

  const models = raw.models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new CoreError("at least one model is required", "invalid");
  }
  const seenIds = new Set<string>();
  const normalizedModels: UserProviderModel[] = models.map((m, i) => {
    if (!isRecord(m)) {
      throw new CoreError(`models[${i}] must be an object`, "invalid");
    }
    if (typeof m.id !== "string" || m.id.trim() === "") {
      throw new CoreError(`models[${i}].id is required`, "invalid");
    }
    if (seenIds.has(m.id)) {
      throw new CoreError(`duplicate model id: ${m.id}`, "invalid");
    }
    seenIds.add(m.id);
    if (m.api !== undefined && !isAllowedApi(m.api)) {
      throw new CoreError(
        `models[${i}].api must be one of ${ALLOWED_OPENAI_APIS.join(", ")}`,
        "invalid",
      );
    }
    if (typeof m.contextWindow === "number" && m.contextWindow <= 0) {
      throw new CoreError(`models[${i}].contextWindow must be positive`, "invalid");
    }
    if (typeof m.maxTokens === "number" && m.maxTokens <= 0) {
      throw new CoreError(`models[${i}].maxTokens must be positive`, "invalid");
    }
    if (m.input !== undefined && !isModelInput(m.input)) {
      throw new CoreError(`models[${i}].input must be ["text"|"image"]`, "invalid");
    }
    if (!isCost(m.cost)) {
      throw new CoreError(`models[${i}].cost is malformed`, "invalid");
    }
    return {
      id: m.id,
      name: typeof m.name === "string" ? m.name : undefined,
      api: typeof m.api === "string" ? m.api : undefined,
      baseUrl: typeof m.baseUrl === "string" ? m.baseUrl : undefined,
      reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
      input: Array.isArray(m.input) ? m.input as ("text" | "image")[] : undefined,
      contextWindow: typeof m.contextWindow === "number"
        ? m.contextWindow
        : undefined,
      maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : undefined,
      cost: typeof m.cost === "object" && m.cost !== null
        ? m.cost as UserProviderModel["cost"]
        : undefined,
    };
  });

  const apiKey = raw.apiKey;
  if (apiKey !== undefined && typeof apiKey !== "string") {
    throw new CoreError("apiKey must be a string", "invalid");
  }

  return {
    id,
    name: name.trim(),
    baseUrl,
    api: raw.api,
    headers: raw.headers as Record<string, string> | undefined,
    models: normalizedModels,
    apiKey: apiKey as string | undefined,
  };
}

/** ApiKeyAuth that resolves the key from the Lumisca credential store
 * (the same place `setProviderApiKey` writes). Ambient env vars are not
 * consulted — a user provider is "configured" only once the user stores a
 * key here. */
function credentialStoreApiKey(
  providerId: string,
  credentials: CredentialStore,
): ApiKeyAuth {
  return {
    name: `API key (${providerId})`,
    login: async (interaction) => {
      interaction.signal.throwIfAborted();
      const key = await interaction.prompt({
        type: "secret",
        message: "Enter API key",
      });
      interaction.signal.throwIfAborted();
      return { type: "api_key", key };
    },
    resolve: async ({ credential, signal }) => {
      signal.throwIfAborted();
      if (credential?.key) {
        return {
          auth: { apiKey: credential.key },
          source: "stored credential",
        };
      }
      return undefined;
    },
  };
}

/** Build a runtime Provider from a stored config. */
export function buildUserProvider(
  config: UserProviderConfig,
  credentials: CredentialStore,
): Provider {
  const models = config.models.map((m) =>
    buildModel(config.id, m, {
      baseUrl: config.baseUrl,
      api: config.api,
      headers: config.headers,
    })
  );
  return buildProvider({
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    headers: config.headers,
    auth: credentialStoreApiKey(config.id, credentials),
    models,
  });
}

/** Settings-backed collection of user-defined providers. */
export class UserProviderStore {
  constructor(private readonly settings: SettingsRepo) {}

  list(): UserProviderConfig[] {
    const raw = this.settings.get(USER_PROVIDERS_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (c): c is UserProviderConfig =>
          isRecord(c) && typeof c.id === "string" &&
          typeof c.baseUrl === "string" && Array.isArray(c.models),
      );
    } catch {
      return [];
    }
  }

  get(id: string): UserProviderConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  ids(): Set<string> {
    return new Set(this.list().map((c) => c.id));
  }

  upsert(config: UserProviderConfig): void {
    const all = this.list().filter((c) => c.id !== config.id);
    all.push(config);
    this.settings.set(USER_PROVIDERS_KEY, JSON.stringify(all));
  }

  remove(id: string): void {
    const all = this.list().filter((c) => c.id !== id);
    if (all.length === 0) this.settings.delete(USER_PROVIDERS_KEY);
    else this.settings.set(USER_PROVIDERS_KEY, JSON.stringify(all));
  }
}
