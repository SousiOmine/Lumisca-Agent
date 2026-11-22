import type {
  AuthCheck,
  AuthInteraction,
  AuthType,
  Credential,
  CredentialStore,
  Model,
  Provider,
} from "../ai/catalog.ts";
import type { LumiscaModels } from "../ai/models.ts";
import type { Api } from "../domain/model.ts";
import type { SettingsRepo } from "../settings/repo.ts";
import type { ModelInfo, ThinkingLevel } from "../shared/mod.ts";
import type { CatalogStatus } from "./catalog-source.ts";
import { CatalogStore } from "./catalog-store.ts";
import { type EnvReader, processEnv } from "./custom.ts";
import { ModelEnablement } from "./model-enablement.ts";
import { describeModel } from "./model-info.ts";
import { ModelPreferences } from "./model-preferences.ts";
import { ProviderCredentials } from "./provider-credentials.ts";
import { ThinkingStore } from "./thinking-store.ts";
import { UserProviderAdmin } from "./user-provider-admin.ts";
import type {
  UserProviderConfig,
  UserProviderInput,
  UserProviderSummary,
} from "./user-providers.ts";

/**
 * The model layer's entry point: the catalog and its providers
 * ({@link CatalogStore}), what a provider's credential means
 * ({@link ProviderCredentials}), the models the settings enable and point at
 * ({@link ModelEnablement}, {@link ModelPreferences}), and the thinking
 * levels a model stores ({@link ThinkingStore}), behind the surface the
 * server and the session agents read.
 *
 * The parts are separate because they answer questions that do not need each
 * other: which models exist, whether a provider may be called, which model a
 * role uses, and how much a model thinks.
 */
export class ModelManager {
  readonly models: LumiscaModels;
  private readonly catalog: CatalogStore;
  private readonly enablement: ModelEnablement;
  private readonly credentials: ProviderCredentials;
  private readonly preferences: ModelPreferences;
  private readonly thinking: ThinkingStore;
  private readonly userProviders: UserProviderAdmin;

  constructor(
    store: CredentialStore,
    settings: SettingsRepo,
    env: EnvReader = processEnv,
  ) {
    this.catalog = new CatalogStore(store, settings, env);
    this.enablement = new ModelEnablement(settings);
    this.models = this.catalog.models;
    this.credentials = new ProviderCredentials(
      this.models,
      store,
      (providerId) => this.catalog.isCustomProvider(providerId),
    );
    this.preferences = new ModelPreferences(settings, (providerId, modelId) =>
      this.getModel(providerId, modelId),
    );
    this.thinking = new ThinkingStore(settings, (providerId, modelId) =>
      this.catalog.getModelWithRetired(providerId, modelId),
    );
    this.userProviders = new UserProviderAdmin(this.catalog, this.credentials);
  }

  /** Where the active built-in catalog came from (live fetch, disk cache,
   * or the bundled snapshot). */
  getCatalogStatus(): CatalogStatus {
    return this.catalog.getCatalogStatus();
  }

  /** Resolve a model including retired ones (existing sessions only).
   * Listings and new-session resolution must use `getModel`, never this. */
  getModelWithRetired(
    providerId: string,
    modelId: string,
  ): Model<Api> | undefined {
    return this.catalog.getModelWithRetired(providerId, modelId);
  }

  /** The configured image-analysis model (the `model_image` setting), or
   * undefined when unset or the model is no longer in the catalog. It
   * interprets images as text for sessions whose main model cannot see
   * them (see agent/image-analysis.ts). */
  getImageAnalysisModel(): Model<Api> | undefined {
    return this.preferences.imageAnalysisModel();
  }

  /** The configured fast model (the `model_fast` setting), or undefined
   * when unset or the model is no longer in the catalog. It generates
   * session titles from the first user message (see
   * agent/title-generation.ts) and runs sub-agents. */
  getFastModel(): Model<Api> | undefined {
    return this.preferences.fastModel();
  }

  /** The configured fast model with its provider/model ids, or undefined
   * when unset or the model is no longer in the catalog. Sub-agents (the
   * task tool) run on this model, with its stored thinking level. */
  getFastModelInfo():
    | { provider: string; modelId: string; model: Model<Api> }
    | undefined {
    return this.preferences.fastModelInfo();
  }

  /** Resolve a provider for existing sessions, including retired ones.
   * Listings must use `getProvider`, never this: a retired provider is only
   * reachable for the sessions that already name it. */
  getProviderWithRetired(providerId: string): Provider | undefined {
    return this.catalog.getProviderWithRetired(providerId);
  }

  /** Whether a retired model is still referenced (kept alive for existing
   * sessions rather than listed). */
  isRetiredModel(providerId: string, modelId: string): boolean {
    return this.catalog.isRetiredModel(providerId, modelId);
  }

  /** Refresh the built-in catalog from models.dev (`live → cache →
   * snapshot`), then re-apply custom/user providers so same-id overrides
   * keep winning. Never throws: a failure is returned on the status. */
  refreshCatalog(
    options: {
      fetch?: typeof globalThis.fetch;
      timeoutMs?: number;
      baseUrl?: string;
    } = {},
  ): Promise<CatalogStatus> {
    return this.catalog.refreshCatalog(options);
  }

  /** Whether the provider id comes from Lumisca's own custom-provider
   * config (models.json / LUMISCA_* env vars, or a user-defined provider)
   * rather than the SDK's built-in catalog. */
  isCustomProvider(providerId: string): boolean {
    return this.catalog.isCustomProvider(providerId);
  }

  /** Whether the provider was added by the user (the settings UI)
   * rather than built in or from the env/models.json custom config. */
  isUserProvider(providerId: string): boolean {
    return this.catalog.isUserProvider(providerId);
  }

  /** Every user-defined provider (with `hasApiKey`, never the key itself). */
  listUserProviders(): Promise<UserProviderSummary[]> {
    return this.userProviders.list();
  }

  /** A single user-defined provider config (for prefilling an edit form),
   * or undefined when it does not exist. */
  getUserProvider(id: string): UserProviderConfig | undefined {
    return this.userProviders.get(id);
  }

  /** Create a user-defined provider. Validates the input, persists it,
   * registers it with the registry, and — when an `apiKey` was supplied —
   * stores it in the credential store. Returns the summary. */
  addUserProvider(input: UserProviderInput): Promise<UserProviderSummary> {
    return this.userProviders.add(input);
  }

  /** Update a user-defined provider (id is fixed by the route). An `apiKey`
   * of `""` clears the stored key; a non-empty `apiKey` replaces it; an
   * omitted `apiKey` leaves the existing key untouched. Returns the
   * summary. */
  updateUserProvider(
    id: string,
    input: UserProviderInput,
  ): Promise<UserProviderSummary> {
    return this.userProviders.update(id, input);
  }

  /** Remove a user-defined provider, unregister it from the registry, and
   * delete any stored API key. */
  removeUserProvider(id: string): Promise<void> {
    return this.userProviders.remove(id);
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

  /** The model for an existing session's prompt/build, including retired
   * models (removed upstream, kept for existing sessions). */
  getSessionModel(providerId: string, modelId: string): Model<Api> | undefined {
    return this.getModelWithRetired(providerId, modelId);
  }

  /** Run a provider-owned login flow (e.g. OAuth) and persist the returned
   * credential. The interaction bridges the flow's prompts and
   * notifications to whoever drives the UI. */
  login(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction,
  ): Promise<Credential> {
    return this.credentials.login(providerId, type, interaction);
  }

  /** Remove the stored credential for a provider. */
  logout(providerId: string): Promise<void> {
    return this.credentials.logout(providerId);
  }

  /** Replace a provider's stored API key. The credential store is the model
   * layer's (a key belongs to a provider, not to the settings table), so a
   * caller that may write keys uses this instead of reaching into
   * settings/credentials.ts with a store it does not own. */
  async setApiKey(providerId: string, key: string): Promise<void> {
    await this.credentials.setApiKey(providerId, key);
  }

  checkAuth(providerId: string): Promise<AuthCheck | undefined> {
    return this.credentials.checkAuth(providerId);
  }

  /** Whether the provider resolves auth (env var or stored key) without a
   * network call — the runtime capability check. Unlike
   * `hasConfiguredAuth`, ambient env keys of built-in providers count. */
  hasProviderAuth(providerId: string): Promise<boolean> {
    return this.credentials.hasProviderAuth(providerId);
  }

  /** Whether the provider is set up inside Lumisca itself: an API key or
   * OAuth credential stored here, or a custom provider from Lumisca's own
   * config (models.json / LUMISCA_* env vars, a user-defined provider)
   * whose auth resolves. Ambient machine auth that the SDK happens to find
   * — e.g. ANTHROPIC_API_KEY or HF_TOKEN set for other tools — does NOT
   * count: providers must not appear as "added" just because an env var
   * exists. This is the same verdict the settings list, the pickers and
   * the default-model resolution use. */
  hasConfiguredAuth(providerId: string): Promise<boolean> {
    return this.credentials.hasConfiguredAuth(providerId);
  }

  /** Enable or disable a model for the UI. Disabled models are hidden
   * from model pickers. Enabled is the default (nothing stored). */
  setModelEnabled(providerId: string, modelId: string, enabled: boolean): void {
    this.enablement.set(providerId, modelId, enabled);
  }

  isModelEnabled(providerId: string, modelId: string): boolean {
    return this.enablement.isEnabled(providerId, modelId);
  }

  /** The stored thinking level of a model, clamped to what it supports.
   * "off" is the default when nothing is stored. Retired models keep
   * their own stored level (their tombstone carries the last live
   * thinking map), so existing sessions stream with the same level. */
  getThinkingLevel(providerId: string, modelId: string): ThinkingLevel {
    return this.thinking.get(providerId, modelId);
  }

  /** The catalog metadata of one model, shaped for the UI (context window,
   * reasoning flag, input modalities). The session decoration and the
   * detailed model list both publish this block, so clients see one shape. */
  describeModel(model: Model<Api>): ModelInfo {
    return describeModel(model);
  }

  /** The thinking state the UI renders for one model: the stored level and
   * the levels the model supports ("off" alone when the model is unknown).
   * `modelId` is the caller's own id (a session keeps its ids after the
   * model is retired), `model` the catalog entry when one is known. */
  thinkingState(
    providerId: string,
    modelId: string,
    model: Model<Api> | undefined,
  ): { thinkingLevel: ThinkingLevel; thinkingLevels: ThinkingLevel[] } {
    return this.thinking.state(providerId, modelId, model);
  }

  /** Store a thinking level for a model. Unsupported levels are clamped to
   * the nearest supported one; "off" removes the entry (the default).
   * Returns the level that will actually be used. Retired models resolve
   * through their tombstone so existing sessions can still tune them. */
  setThinkingLevel(
    providerId: string,
    modelId: string,
    level: ThinkingLevel,
  ): ThinkingLevel {
    return this.thinking.set(providerId, modelId, level);
  }

  /** First enabled model across *configured* providers (the default-model
   * fallback). Providers without configured credentials are skipped: no
   * surface offers them (the pickers list configured providers only) and a
   * session created on one could not stream, so a built-in catalog entry
   * must never become a default model by itself. Returns null when nothing
   * is configured — the caller then has no default model at all (see
   * `LumiscaCore.getDefaultModel`). */
  async getFallbackModel(): Promise<{
    provider: string;
    modelId: string;
  } | null> {
    for (const p of this.getProviders()) {
      if (!(await this.hasConfiguredAuth(p.id))) continue;
      const model = this.getModels(p.id).find((m) =>
        this.isModelEnabled(p.id, m.id),
      );
      if (model) return { provider: p.id, modelId: model.id };
    }
    return null;
  }
}

export type {
  CatalogSource,
  CatalogSourceKind,
  CatalogStatus,
} from "./catalog-source.ts";
// Re-exported types for the server layer's user-provider surface.
export type {
  UserProviderConfig,
  UserProviderInput,
  UserProviderSummary,
} from "./user-providers.ts";
