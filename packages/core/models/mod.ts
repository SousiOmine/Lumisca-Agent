import { LumiscaModels } from "../ai/models.ts";
import type {
  Api,
  AuthCheck,
  AuthInteraction,
  AuthType,
  Credential,
  CredentialStore,
  Model,
  ModelsStore,
  ModelsStoreEntry,
  Provider,
} from "../ai/types.ts";
import type { SettingsRepo } from "../settings/repo.ts";
import { safeJsonParse, type ThinkingLevel } from "../shared/mod.ts";
import { CoreError } from "../errors.ts";
import type {
  UserProviderConfig,
  UserProviderInput,
  UserProviderSummary,
} from "./user-providers.ts";
import { buildUserProvider, parseUserProviderInput, UserProviderStore } from "./user-providers.ts";
import { extraProviders } from "./extra-providers.ts";
import { loadCustomProviders } from "./custom.ts";
import { builtinProviders } from "./dev-catalog.ts";
import { clampThinkingLevel } from "./thinking.ts";
import { setApiKey } from "../settings/credentials.ts";

const CATALOG_PREFIX = "model_catalog:";
const ENABLED_PREFIX = "model_enabled:";
const THINKING_PREFIX = "model_thinking:";

/** Persistent model catalog cache stored in the settings store. Kept for
 * compatibility with the original ModelManager signature. */
export function createDbModelsStore(settings: SettingsRepo): ModelsStore {
  return {
    read(providerId: string): Promise<ModelsStoreEntry | undefined> {
      const raw = settings.get(`${CATALOG_PREFIX}${providerId}`);
      return Promise.resolve(safeJsonParse<ModelsStoreEntry>(raw));
    },
    write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
      settings.set(`${CATALOG_PREFIX}${providerId}`, JSON.stringify(entry));
      return Promise.resolve();
    },
    delete(providerId: string): Promise<void> {
      settings.delete(`${CATALOG_PREFIX}${providerId}`);
      return Promise.resolve();
    },
  };
}

/** Owns the Lumisca model registry and resolves providers/models. */
export class ModelManager {
  readonly models: LumiscaModels;
  private readonly settings: SettingsRepo;
  private readonly credentials: CredentialStore;
  /** Ids of providers defined by Lumisca's own config (models.json,
   * LUMISCA_* env vars). Unlike the built-ins, these are explicit app
   * configuration — they count as "configured" even without a stored
   * credential. */
  private readonly customProviderIds: ReadonlySet<string>;
  /** Ids of user-defined providers (the settings UI / CLI can add these at
   * runtime). Treated like the other custom providers for `isCustomProvider`. */
  private readonly userProviderIds: Set<string>;
  private readonly userStore: UserProviderStore;

  constructor(
    credentials: CredentialStore,
    settings: SettingsRepo,
    _modelsStore?: ModelsStore,
  ) {
    this.models = new LumiscaModels({
      credentials,
      env: () => Deno.env.toObject(),
    });
    this.settings = settings;
    this.credentials = credentials;
    // ai-sdk built-in providers (OpenAI, Anthropic, Google, Mistral).
    for (const provider of builtinProviders()) {
      this.models.setProvider(provider);
    }
    // Lumisca-shipped providers outside the SDK catalog (DeepInfra,
    // ClinePass, OpenCode Go) are registered right after the builtins.
    for (const provider of extraProviders()) {
      this.models.setProvider(provider);
    }
    // Custom OpenAI-compatible providers (env vars / models.json) are
    // registered after the builtins. setProvider upserts by id, so:
    // - a models.json provider may intentionally replace a builtin
    //   provider of the same id (e.g. point "openai" at a compatible
    //   endpoint) — this is the override mechanism, not an accident;
    // - the env-var provider is registered last, so it wins collisions
    //   with models.json ids.
    const customProviders = loadCustomProviders();
    const customIds = new Set(customProviders.map((p) => p.id));
    for (const provider of customProviders) {
      this.models.setProvider(provider);
    }
    // User-defined providers are loaded from the settings store and
    // registered after the other custom providers.
    this.userStore = new UserProviderStore(settings);
    for (const config of this.userStore.list()) {
      customIds.add(config.id);
      this.models.setProvider(buildUserProvider(config));
    }
    this.customProviderIds = customIds;
    this.userProviderIds = new Set(this.userStore.ids());
  }

  /** Whether the provider id comes from Lumisca's own custom-provider
   * config (models.json / LUMISCA_* env vars, or a user-defined provider)
   * rather than the SDK's built-in catalog. */
  isCustomProvider(providerId: string): boolean {
    return this.customProviderIds.has(providerId);
  }

  /** Whether the provider was added by the user (the settings UI / CLI)
   * rather than built in or from the env/models.json custom config. */
  isUserProvider(providerId: string): boolean {
    return this.userProviderIds.has(providerId);
  }

  // --- user-defined OpenAI-compatible providers ----------------------------

  /** Every user-defined provider (with `hasApiKey`, never the key itself). */
  async listUserProviders(): Promise<UserProviderSummary[]> {
    const out: UserProviderSummary[] = [];
    for (const config of this.userStore.list()) {
      out.push(await this.summarizeUserProvider(config));
    }
    return out;
  }

  /** A single user-defined provider config (for prefilling an edit form),
   * or undefined when it does not exist. */
  getUserProvider(id: string): UserProviderConfig | undefined {
    return this.userStore.get(id);
  }

  /** Create a user-defined provider. Validates the input, persists it,
   * registers it with the registry, and — when an `apiKey` was supplied —
   * stores it in the credential store. Returns the summary. */
  async addUserProvider(
    input: UserProviderInput,
  ): Promise<UserProviderSummary> {
    const parsed = parseUserProviderInput(input);
    this.userStore.upsert(parsed);
    this.models.setProvider(buildUserProvider(parsed));
    this.userProviderIds.add(parsed.id);
    (this.customProviderIds as Set<string>).add(parsed.id);
    if (parsed.apiKey) {
      await setApiKey(this.credentials, parsed.id, parsed.apiKey);
    }
    return await this.summarizeUserProvider(parsed);
  }

  /** Update a user-defined provider (id is fixed by the route). Validates
   * the input, persists and re-registers it. An `apiKey` of `""` clears the
   * stored key; a non-empty `apiKey` replaces it; an omitted `apiKey` leaves
   * the existing key untouched. Returns the summary. */
  async updateUserProvider(
    id: string,
    input: UserProviderInput,
  ): Promise<UserProviderSummary> {
    if (!this.userStore.get(id)) {
      throw new CoreError(`User provider not found: ${id}`, "not_found");
    }
    const parsed = parseUserProviderInput({ ...input, id }, {
      requireId: true,
    });
    this.userStore.upsert(parsed);
    this.models.setProvider(buildUserProvider(parsed));
    if (parsed.apiKey !== undefined) {
      if (parsed.apiKey === "") await this.credentials.delete(id);
      else await setApiKey(this.credentials, id, parsed.apiKey);
    }
    return await this.summarizeUserProvider(parsed);
  }

  /** Remove a user-defined provider, unregister it from the registry, and
   * delete any stored API key. */
  async removeUserProvider(id: string): Promise<void> {
    if (!this.userStore.get(id)) {
      throw new CoreError(`User provider not found: ${id}`, "not_found");
    }
    this.userStore.remove(id);
    this.models.deleteProvider(id);
    this.userProviderIds.delete(id);
    (this.customProviderIds as Set<string>).delete(id);
    await this.credentials.delete(id);
  }

  private async summarizeUserProvider(
    config: UserProviderConfig,
  ): Promise<UserProviderSummary> {
    const credential = await this.credentials.read(config.id);
    return {
      ...config,
      hasApiKey: credential?.type === "api_key" && credential.key !== "",
    };
  }

  getProviders(): readonly Provider[] {
    return this.models.getProviders();
  }

  getModels(providerId?: string): readonly Model<Api>[] {
    return this.models.getModels(providerId);
  }

  getModel(providerId: string, modelId: string): Model<Api> | undefined {
    return this.models.getModel(providerId, modelId);
  }

  getProvider(providerId: string): Provider | undefined {
    return this.models.getProvider(providerId);
  }

  /** Run a provider-owned login flow (e.g. OAuth) and persist the returned
   * credential. The interaction bridges the flow's prompts and
   * notifications to whoever drives the UI. */
  login(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction,
  ): Promise<Credential> {
    return this.models.login(providerId, type, interaction);
  }

  /** Remove the stored credential for a provider. */
  logout(providerId: string): Promise<void> {
    return this.models.logout(providerId);
  }

  async checkAuth(
    providerId: string,
  ): Promise<AuthCheck | undefined> {
    return await this.models.checkAuth(providerId);
  }

  /** Whether the provider resolves auth (env var or stored key) without a
   * network call — the runtime capability check. Unlike
   * `hasConfiguredAuth`, ambient env keys of built-in providers count. */
  async hasProviderAuth(providerId: string): Promise<boolean> {
    return (await this.models.checkAuth(providerId)) !== undefined;
  }

  /** Enable or disable a model for the UI. Disabled models are hidden
   * from model pickers. Enabled is the default (nothing stored). */
  setModelEnabled(providerId: string, modelId: string, enabled: boolean): void {
    const key = `${ENABLED_PREFIX}${providerId}:${modelId}`;
    if (enabled) {
      this.settings.delete(key);
    } else {
      this.settings.set(key, "0");
    }
  }

  isModelEnabled(providerId: string, modelId: string): boolean {
    return this.settings.get(`${ENABLED_PREFIX}${providerId}:${modelId}`) !==
      "0";
  }

  /** The stored thinking level of a model, clamped to what it supports.
   * "off" is the default when nothing is stored. */
  getThinkingLevel(providerId: string, modelId: string): ThinkingLevel {
    const model = this.getModel(providerId, modelId);
    const stored = this.settings.get(
      `${THINKING_PREFIX}${providerId}:${modelId}`,
    );
    return clampThinkingLevel(model, stored as ThinkingLevel ?? "off");
  }

  /** Store a thinking level for a model. Unsupported levels are clamped to
   * the nearest supported one; "off" removes the entry (the default).
   * Returns the level that will actually be used. */
  setThinkingLevel(
    providerId: string,
    modelId: string,
    level: ThinkingLevel,
  ): ThinkingLevel {
    const model = this.getModel(providerId, modelId);
    const effective = clampThinkingLevel(model, level);
    const key = `${THINKING_PREFIX}${providerId}:${modelId}`;
    if (effective === "off") {
      this.settings.delete(key);
    } else {
      this.settings.set(key, effective);
    }
    return effective;
  }

  /** First enabled model across providers (the default-model fallback). */
  getFallbackModel(): { provider: string; modelId: string } | null {
    for (const p of this.getProviders()) {
      const model = this.getModels(p.id).find((m) =>
        this.isModelEnabled(p.id, m.id)
      );
      if (model) return { provider: p.id, modelId: model.id };
    }
    return null;
  }
}

// Re-exported types for the server layer's user-provider surface.
export type {
  UserProviderConfig,
  UserProviderInput,
  UserProviderSummary,
} from "./user-providers.ts";
