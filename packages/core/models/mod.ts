import { builtinModels } from "@earendil-works/pi-ai/providers/all";
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
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import type { SettingsRepo } from "../settings/repo.ts";
import type { ThinkingLevel } from "../shared.ts";
import { CoreError } from "../errors.ts";
import { loadCustomProviders } from "./custom.ts";
import { extraProviders } from "./extra-providers.ts";
import { clampThinkingLevel } from "./thinking.ts";
import {
  buildUserProvider,
  parseUserProviderInput,
  type UserProviderConfig,
  type UserProviderInput,
  UserProviderStore,
  type UserProviderSummary,
} from "./user-providers.ts";
import { setApiKey } from "../settings/credentials.ts";

const CATALOG_PREFIX = "model_catalog:";
const ENABLED_PREFIX = "model_enabled:";
const THINKING_PREFIX = "model_thinking:";

/** Persistent model catalog cache stored in the settings store. */
export function createDbModelsStore(settings: SettingsRepo): ModelsStore {
  return {
    read(providerId: string): Promise<ModelsStoreEntry | undefined> {
      const raw = settings.get(`${CATALOG_PREFIX}${providerId}`);
      if (!raw) return Promise.resolve(undefined);
      try {
        return Promise.resolve(JSON.parse(raw) as ModelsStoreEntry);
      } catch {
        return Promise.resolve(undefined);
      }
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

/** Owns the pi-ai Models collection and resolves providers/models. */
export class ModelManager {
  readonly models: MutableModels;
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
    modelsStore?: ModelsStore,
  ) {
    this.models = builtinModels({ credentials, modelsStore }) as MutableModels;
    this.settings = settings;
    this.credentials = credentials;
    // Lumisca-shipped providers outside the SDK catalog (DeepInfra,
    // ClinePass) are registered right after the builtins. setProvider
    // upserts by id, so the custom providers below can still override
    // them (e.g. point "deepinfra" at a compatible endpoint).
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
    // registered after the other custom providers (so a user can override a
    // builtin id too — e.g. point "openai" at a compatible endpoint).
    this.userStore = new UserProviderStore(settings);
    for (const config of this.userStore.list()) {
      customIds.add(config.id);
      this.models.setProvider(buildUserProvider(config, credentials));
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
   * registers it with the SDK, and — when an `apiKey` was supplied —
   * stores it in the credential store. Returns the summary. */
  async addUserProvider(
    input: UserProviderInput,
  ): Promise<UserProviderSummary> {
    const parsed = parseUserProviderInput(input);
    this.userStore.upsert(parsed);
    this.models.setProvider(buildUserProvider(parsed, this.credentials));
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
    this.models.setProvider(buildUserProvider(parsed, this.credentials));
    if (parsed.apiKey !== undefined) {
      if (parsed.apiKey === "") await this.credentials.delete(id);
      else await setApiKey(this.credentials, id, parsed.apiKey);
    }
    return await this.summarizeUserProvider(parsed);
  }

  /** Remove a user-defined provider, unregister it from the SDK, and delete
   * any stored API key. */
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
      hasApiKey: credential?.key !== undefined && credential.key !== "",
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
   * `LumiscaCore.hasConfiguredAuth`, ambient env keys of built-in
   * providers count, so this must not be used to decide what the UI
   * offers. */
  async hasProviderAuth(providerId: string): Promise<boolean> {
    return (await this.models.getAuth(providerId)) !== undefined;
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
