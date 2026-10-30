import { LumiscaModels } from "../ai/models.ts";
import type {
  Api,
  AuthCheck,
  AuthInteraction,
  AuthType,
  Credential,
  CredentialStore,
  Model,
  Provider,
} from "../ai/types.ts";
import type { SettingsRepo } from "../settings/repo.ts";
import type { ModelInfo, ThinkingLevel } from "../shared/mod.ts";
import { CoreError, errorMessage } from "../errors.ts";
import type {
  UserProviderConfig,
  UserProviderInput,
  UserProviderSummary,
} from "./user-providers.ts";
import {
  buildUserProvider,
  parseUserProviderInput,
  UserProviderStore,
} from "./user-providers.ts";
import {
  type EnvReader,
  loadCustomProviders,
  processEnv,
} from "./custom.ts";
import {
  buildCatalogProviders,
  builtinProviders,
  DEV_PROVIDER_IDS,
} from "./dev-catalog.ts";
import {
  type CatalogStatus,
  resolveCatalogSource,
  snapshotCatalog,
} from "./catalog-source.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "./thinking.ts";
import { setApiKey } from "../settings/credentials.ts";
import {
  FAST_MODEL_KEY,
  IMAGE_MODEL_KEY,
  MODEL_ENABLED_PREFIX,
  MODEL_THINKING_PREFIX,
  parseModelPreference,
} from "../shared/settings-keys.ts";
import { createLogger } from "../log.ts";

const log = createLogger("catalog");

/** Owns the Lumisca model registry and resolves providers/models. */
/** A provider removed from the catalog, kept for the sessions that already
 * reference it: the provider itself (with its auth definition and headers)
 * and the models that disappeared with it.
 *
 * The whole provider is kept, not just its models: credential resolution runs
 * through `provider.resolveCredential`, so a stand-in without auth could
 * never resolve a stored key or an env var, and every retired session would
 * fail with "Provider is not configured" — the opposite of what keeping the
 * provider alive is for. */
interface RetiredProvider {
  /** The provider as it was: id, name, baseUrl, headers and auth. */
  provider: Provider;
  /** The models that went away with it (or with an update), by id. */
  models: Map<string, Model<Api>>;
}

export class ModelManager {
  readonly models: LumiscaModels;
  private readonly settings: SettingsRepo;
  private readonly credentials: CredentialStore;
  /** Ids of providers defined by Lumisca's own config (models.json,
   * LUMISCA_* env vars). Unlike the built-ins, these are explicit app
   * configuration — they count as "configured" even without a stored
   * credential. */
  private customProviderIds = new Set<string>();
  /** Ids of user-defined providers (the settings UI can add these at
   * runtime). Treated like the other custom providers for `isCustomProvider`. */
  private userProviderIds = new Set<string>();
  private readonly userStore: UserProviderStore;
  /** The environment the custom provider sources are read from. Stored so
   * `refreshCatalog` re-reads the same one the constructor did. */
  private readonly env: EnvReader;
  /** Where the active built-in catalog came from (live fetch, disk cache,
   * or the bundled snapshot). Starts as the snapshot the constructor
   * registered; every `refreshCatalog` replaces it. */
  private catalogStatus: CatalogStatus;
  /** Providers removed from the catalog, kept for the sessions that already
   * reference them (see {@link RetiredProvider}). Filled by
   * `refreshCatalog`, never by construction. */
  private readonly retired = new Map<string, RetiredProvider>();

  constructor(
    credentials: CredentialStore,
    settings: SettingsRepo,
    env: EnvReader = processEnv,
  ) {
    this.env = env;
    this.models = new LumiscaModels({
      credentials,
      env,
    });
    this.settings = settings;
    this.credentials = credentials;
    this.userStore = new UserProviderStore(settings);
    // ai-sdk built-in providers (OpenAI, Anthropic, Google, Mistral) plus
    // every other models.dev provider on the allow-list (DeepInfra,
    // ClinePass, OpenCode Go, …) — all of them come from the same catalog.
    for (const provider of builtinProviders()) {
      this.models.setProvider(provider);
    }
    this.applyCustomProviders();
    const bundled = snapshotCatalog();
    this.catalogStatus = {
      source: "snapshot",
      ...(bundled.generatedAt !== undefined
        ? { generatedAt: bundled.generatedAt }
        : {}),
      lastCheckAt: Date.now(),
    };
  }

  /** Register custom (models.json / env) and user-defined providers after
   * the built-ins. Shared by the constructor and `refreshCatalog` so a
   * catalog refresh never loses an intentional same-id override. */
  private applyCustomProviders(): void {
    // Custom OpenAI-compatible providers (env vars / models.json) are
    // registered after the builtins. setProvider upserts by id, so:
    // - a models.json provider may intentionally replace a builtin
    //   provider of the same id (e.g. point "openai" at a compatible
    //   endpoint) — this is the override mechanism, not an accident;
    // - the env-var provider is registered last, so it wins collisions
    //   with models.json ids.
    const customProviders = loadCustomProviders(this.env);
    const customIds = new Set(customProviders.map((p) => p.id));
    for (const provider of customProviders) {
      this.models.setProvider(provider);
    }
    // User-defined providers are loaded from the settings store and
    // registered after the other custom providers.
    for (const config of this.userStore.list()) {
      customIds.add(config.id);
      this.models.setProvider(buildUserProvider(config));
    }
    this.customProviderIds = customIds;
    this.userProviderIds = new Set(this.userStore.ids());
  }

  /** Where the active built-in catalog came from (live fetch, disk cache,
   * or the bundled snapshot). */
  getCatalogStatus(): CatalogStatus {
    return { ...this.catalogStatus };
  }

  /** Resolve a model including retired ones (existing sessions only).
   * Listings and new-session resolution must use `getModel`, never this. */
  getModelWithRetired(
    providerId: string,
    modelId: string,
  ): Model<Api> | undefined {
    return this.models.getModel(providerId, modelId) ??
      this.retired.get(providerId)?.models.get(modelId);
  }

  /** The configured image-analysis model (the `model_image` setting), or
   * undefined when unset or the model is no longer in the catalog. It
   * interprets images as text for sessions whose main model cannot see
   * them (see agent/image-analysis.ts). */
  getImageAnalysisModel(): Model<Api> | undefined {
    const pref = parseModelPreference(this.settings.get(IMAGE_MODEL_KEY));
    if (pref === undefined) return undefined;
    return this.getModel(pref.provider, pref.modelId);
  }

  /** The configured fast model (the `model_fast` setting), or undefined
   * when unset or the model is no longer in the catalog. It generates
   * session titles from the first user message (see
   * agent/title-generation.ts) and runs sub-agents. */
  getFastModel(): Model<Api> | undefined {
    return this.getFastModelInfo()?.model;
  }

  /** The configured fast model with its provider/model ids, or undefined
   * when unset or the model is no longer in the catalog. Sub-agents (the
   * task tool) run on this model, with its stored thinking level. */
  getFastModelInfo():
    | { provider: string; modelId: string; model: Model<Api> }
    | undefined {
    const pref = parseModelPreference(this.settings.get(FAST_MODEL_KEY));
    if (pref === undefined) return undefined;
    const model = this.getModel(pref.provider, pref.modelId);
    if (model === undefined) return undefined;
    return { provider: pref.provider, modelId: pref.modelId, model };
  }

  /** Resolve a provider for existing sessions, including retired ones.
   * Listings must use `getProvider`, never this: a retired provider is only
   * reachable for the sessions that already name it.
   *
   * The retired entry IS the provider that served those sessions, so its
   * credential resolution keeps working: a stored key or an env var resolved
   * before the removal resolves after it too. */
  getProviderWithRetired(providerId: string): Provider | undefined {
    return this.models.getProvider(providerId) ??
      this.retired.get(providerId)?.provider;
  }

  /** Whether a retired model is still referenced (kept alive for existing
   * sessions rather than listed). */
  isRetiredModel(providerId: string, modelId: string): boolean {
    return this.models.getModel(providerId, modelId) === undefined &&
      this.retired.get(providerId)?.models.has(modelId) === true;
  }

  /** Refresh the built-in catalog from models.dev (`live → cache →
   * snapshot`), then re-apply custom/user providers so same-id overrides
   * keep winning. Custom/user providers and their ids are untouched by the
   * diff itself: only allow-listed ids are added/updated/removed. Stale
   * custom entries (removed from models.json/env/user settings since the
   * last apply) are unregistered, restoring the same-id built-in when the
   * live catalog still carries it. Custom/user misconfiguration (an
   * unreadable models.json, a partial env pair, an invalid stored user
   * provider) never throws: the previous registry is kept and the failure
   * is returned on the status (`error`). */
  async refreshCatalog(
    options: {
      fetch?: typeof globalThis.fetch;
      timeoutMs?: number;
      baseUrl?: string;
    } = {},
  ): Promise<CatalogStatus> {
    const { source, status } = await resolveCatalogSource({
      settings: this.settings,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      baseUrl: options.baseUrl,
    });
    const previousCustomIds = new Set([
      ...this.customProviderIds,
      ...this.userProviderIds,
    ]);
    const rebuilt = new Map(
      buildCatalogProviders(source.providers).map((p) => [p.id, p] as const),
    );
    for (const id of DEV_PROVIDER_IDS) {
      if (previousCustomIds.has(id)) {
        continue;
      }
      const next = rebuilt.get(id);
      const current = this.models.getProvider(id);
      if (next !== undefined) {
        if (current !== undefined) this.retireRemovedModels(current, next);
        this.models.setProvider(next);
      } else {
        if (current !== undefined) {
          this.retireProvider(current);
          this.models.deleteProvider(id);
        }
      }
    }
    try {
      this.applyCustomProviders();
    } catch (error) {
      const message = errorMessage(error);
      log.debug(`custom providers unreadable, keeping previous: ${message}`);
      return {
        ...status,
        error: status.error === undefined
          ? `custom providers unavailable: ${message}`
          : `${status.error}; custom providers unavailable: ${message}`,
      };
    }
    const freshCustomIds = new Set([
      ...this.customProviderIds,
      ...this.userProviderIds,
    ]);
    for (const id of previousCustomIds) {
      if (freshCustomIds.has(id)) continue;
      const current = this.models.getProvider(id);
      if (current === undefined) continue;
      const revived = rebuilt.get(id);
      if (revived !== undefined) {
        this.models.setProvider(revived);
      } else {
        this.retireProvider(current);
        this.models.deleteProvider(id);
      }
    }
    this.catalogStatus = status;
    return this.getCatalogStatus();
  }

  /** Remember a removed provider (with its auth and headers) and its models
   * before it leaves the registry (see {@link RetiredProvider}). */
  private retireProvider(provider: Provider): void {
    if (provider.getModels().length === 0) return;
    const kept = this.retiredEntry(provider.id, provider);
    for (const model of provider.getModels()) kept.models.set(model.id, model);
  }

  /** Remember the models a provider update dropped (same provider id, model
   * gone upstream). Models still present are refreshed out of the retired
   * set so a re-added model resolves to its live form, not the tombstone. */
  private retireRemovedModels(previous: Provider, next: Provider): void {
    const liveIds = new Set(next.getModels().map((m) => m.id));
    let kept = this.retired.get(previous.id);
    for (const model of previous.getModels()) {
      if (liveIds.has(model.id)) {
        kept?.models.delete(model.id);
        continue;
      }
      kept = this.retiredEntry(previous.id, previous);
      kept.models.set(model.id, model);
    }
    if (kept !== undefined && kept.models.size === 0) {
      this.retired.delete(previous.id);
    }
  }

  /** The retired entry of a provider, created on first use. The FIRST
   * provider seen for an id wins: it is the one a live session was built
   * against, so its baseUrl, headers and auth are the ones that keep working
   * (a later refresh cannot rewrite the connection a session relies on). */
  private retiredEntry(
    providerId: string,
    provider: Provider,
  ): RetiredProvider {
    const existing = this.retired.get(providerId);
    if (existing !== undefined) return existing;
    const created: RetiredProvider = {
      provider,
      models: new Map(),
    };
    this.retired.set(providerId, created);
    return created;
  }

  /** Whether the provider id comes from Lumisca's own custom-provider
   * config (models.json / LUMISCA_* env vars, or a user-defined provider)
   * rather than the SDK's built-in catalog. */
  isCustomProvider(providerId: string): boolean {
    return this.customProviderIds.has(providerId);
  }

  /** Whether the provider was added by the user (the settings UI)
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
    this.customProviderIds.add(parsed.id);
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
    this.customProviderIds.delete(id);
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

  /** The model for an existing session's prompt/build, including retired
   * models (removed upstream, kept for existing sessions). */
  getSessionModel(
    providerId: string,
    modelId: string,
  ): Model<Api> | undefined {
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

  /** Whether the provider is set up inside Lumisca itself: an API key or
   * OAuth credential stored here, or a custom provider from Lumisca's own
   * config (models.json / LUMISCA_* env vars, a user-defined provider)
   * whose auth resolves. Ambient machine auth that the SDK happens to find
   * — e.g. ANTHROPIC_API_KEY or HF_TOKEN set for other tools — does NOT
   * count: providers must not appear as "added" just because an env var
   * exists. This is the same verdict the settings list, the pickers and
   * the default-model resolution use. */
  async hasConfiguredAuth(providerId: string): Promise<boolean> {
    if ((await this.credentials.read(providerId)) !== undefined) {
      return true;
    }
    return this.isCustomProvider(providerId) &&
      await this.hasProviderAuth(providerId);
  }

  /** Enable or disable a model for the UI. Disabled models are hidden
   * from model pickers. Enabled is the default (nothing stored). */
  setModelEnabled(providerId: string, modelId: string, enabled: boolean): void {
    const key = `${MODEL_ENABLED_PREFIX}${providerId}:${modelId}`;
    if (enabled) {
      this.settings.delete(key);
    } else {
      this.settings.set(key, "0");
    }
  }

  isModelEnabled(providerId: string, modelId: string): boolean {
    return this.settings.get(
      `${MODEL_ENABLED_PREFIX}${providerId}:${modelId}`,
    ) !==
      "0";
  }

  /** The stored thinking level of a model, clamped to what it supports.
   * "off" is the default when nothing is stored. Retired models keep
   * their own stored level (their tombstone carries the last live
   * thinking map), so existing sessions stream with the same level. */
  getThinkingLevel(providerId: string, modelId: string): ThinkingLevel {
    const model = this.getModelWithRetired(providerId, modelId);
    const stored = this.settings.get(
      `${MODEL_THINKING_PREFIX}${providerId}:${modelId}`,
    );
    return clampThinkingLevel(model, stored as ThinkingLevel ?? "off");
  }

  /** The catalog metadata of one model, shaped for the UI (context window,
   * reasoning flag, input modalities). The session decoration and the
   * detailed model list both publish this block, so clients see one shape. */
  describeModel(model: Model<Api>): ModelInfo {
    return {
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxInputTokens: model.maxInputTokens,
      reasoning: model.reasoning,
      input: model.input,
    };
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
    return {
      thinkingLevel: this.getThinkingLevel(providerId, modelId),
      thinkingLevels: getSupportedThinkingLevels(model),
    };
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
    const model = this.getModelWithRetired(providerId, modelId);
    const effective = clampThinkingLevel(model, level);
    const key = `${MODEL_THINKING_PREFIX}${providerId}:${modelId}`;
    if (effective === "off") {
      this.settings.delete(key);
    } else {
      this.settings.set(key, effective);
    }
    return effective;
  }

  /** First enabled model across *configured* providers (the default-model
   * fallback). Providers without configured credentials are skipped: no
   * surface offers them (the pickers list configured providers only) and a
   * session created on one could not stream, so a built-in catalog entry
   * must never become a default model by itself. Returns null when nothing
   * is configured — the caller then has no default model at all (see
   * `LumiscaCore.getDefaultModel`). */
  async getFallbackModel(): Promise<
    { provider: string; modelId: string } | null
  > {
    for (const p of this.getProviders()) {
      if (!await this.hasConfiguredAuth(p.id)) continue;
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
export type {
  CatalogSource,
  CatalogSourceKind,
  CatalogStatus,
} from "./catalog-source.ts";
