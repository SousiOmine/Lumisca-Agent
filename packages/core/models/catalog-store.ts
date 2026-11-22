import type { CredentialStore, Model, Provider } from "../ai/catalog.ts";
import { LumiscaModels } from "../ai/models.ts";
import type { Api } from "../domain/model.ts";
import { errorMessage } from "../errors.ts";
import { createLogger } from "../log.ts";
import type { SettingsRepo } from "../settings/repo.ts";
import { parseCompactionPolicyInput } from "../shared/settings-keys.ts";
import {
  type CatalogStatus,
  resolveCatalogSource,
  snapshotCatalog,
} from "./catalog-source.ts";
import { chatgptProvider } from "./chatgpt/provider.ts";
import { type EnvReader, loadCustomProviders } from "./custom.ts";
import {
  buildCatalogProviders,
  builtinProviders,
  DEV_PROVIDER_IDS,
} from "./dev-catalog.ts";
import { RetiredProviders } from "./retired-providers.ts";
import type { UserProviderConfig } from "./user-providers.ts";
import { buildUserProvider, UserProviderStore } from "./user-providers.ts";

const log = createLogger("catalog");

/**
 * The provider/model storage of the model layer: the `LumiscaModels`
 * registry with everything that fills it (the models.dev catalog, the
 * ChatGPT subscription provider, models.json/env providers, user-defined
 * providers), the tombstones of what a refresh removed, and where the live
 * catalog came from.
 *
 * Nothing here decides what a credential or a thinking level means; it only
 * keeps the registry and knows which ids came from Lumisca's own config
 * rather than the SDK's catalog.
 */
export class CatalogStore {
  readonly models: LumiscaModels;
  private readonly settings: SettingsRepo;
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
   * reference them. Filled by `refreshCatalog`, never by construction. */
  private readonly retired = new RetiredProviders();

  constructor(
    credentials: CredentialStore,
    settings: SettingsRepo,
    env: EnvReader,
  ) {
    this.env = env;
    this.settings = settings;
    this.models = new LumiscaModels({
      credentials,
      env,
      // The same tuning the session agents compact with (see
      // LumiscaCore.getCompactionPolicy): the request's completion cap and
      // the threshold it must not cross come from one place.
      compactionPolicy: () =>
        parseCompactionPolicyInput((key) => this.settings.get(key)),
    });
    this.userStore = new UserProviderStore(settings);
    // ai-sdk built-in providers (OpenAI, Anthropic, Google, Mistral) plus
    // every other models.dev provider on the allow-list (DeepInfra,
    // ClinePass, OpenCode Go, …) — all of them come from the same catalog.
    for (const provider of builtinProviders()) {
      this.models.setProvider(provider);
    }
    // The subscription provider sits between the catalog and the custom
    // providers: a models.json entry of the same id still overrides it.
    this.models.setProvider(chatgptProvider({ credentials, settings }));
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
    return (
      this.models.getModel(providerId, modelId) ??
      this.retired.modelOf(providerId, modelId)
    );
  }

  /** Resolve a provider for existing sessions, including retired ones.
   * Listings must use `getProvider`, never this: a retired provider is only
   * reachable for the sessions that already name it.
   *
   * The retired entry IS the provider that served those sessions, so its
   * credential resolution keeps working: a stored key or an env var resolved
   * before the removal resolves after it too. */
  getProviderWithRetired(providerId: string): Provider | undefined {
    return (
      this.models.getProvider(providerId) ?? this.retired.providerOf(providerId)
    );
  }

  /** Whether a retired model is still referenced (kept alive for existing
   * sessions rather than listed). */
  isRetiredModel(providerId: string, modelId: string): boolean {
    return (
      this.models.getModel(providerId, modelId) === undefined &&
      this.retired.has(providerId, modelId)
    );
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
        if (current !== undefined) {
          this.retired.retainRemovedModels(current, next);
        }
        this.models.setProvider(next);
      } else {
        if (current !== undefined) {
          this.retired.retain(current);
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
        error:
          status.error === undefined
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
        this.retired.retain(current);
        this.models.deleteProvider(id);
      }
    }
    this.catalogStatus = status;
    return this.getCatalogStatus();
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

  /** Every stored user-defined provider configuration, as persisted (the API
   * key is not part of it: it lives in the credential store). */
  userProviderConfigs(): UserProviderConfig[] {
    return this.userStore.list();
  }

  /** One stored user-defined provider configuration, or undefined. */
  userProviderConfig(id: string): UserProviderConfig | undefined {
    return this.userStore.get(id);
  }

  /** Persist a user-defined provider and register it, so it is callable the
   * moment the caller's write returns. */
  applyUserProvider(config: UserProviderConfig): void {
    this.userStore.upsert(config);
    this.models.setProvider(buildUserProvider(config));
  }

  /** Count a user-defined provider as custom: it comes from Lumisca's own
   * settings, not the SDK's catalog (see `isCustomProvider`). */
  markUserProvider(id: string): void {
    this.userProviderIds.add(id);
    this.customProviderIds.add(id);
  }

  /** Forget a user-defined provider: drop the config, unregister it from the
   * registry, and stop counting its id as custom. */
  dropUserProvider(id: string): void {
    this.userStore.remove(id);
    this.models.deleteProvider(id);
    this.userProviderIds.delete(id);
    this.customProviderIds.delete(id);
  }
}
