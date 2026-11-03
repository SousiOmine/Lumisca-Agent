import type { Api, AuthCheck, Model, Provider } from "../ai/types.ts";
import type { CatalogStatus, ModelManager } from "../models/mod.ts";
import type {
  UserProviderConfig,
  UserProviderInput,
  UserProviderSummary,
} from "../models/user-providers.ts";
import type { ThinkingLevel } from "../shared/mod.ts";

/**
 * The model catalog as the routes read it: which providers exist, their
 * models, their credentials, the enablement flags and the live models.dev
 * catalog.
 *
 * One delegation per method to the ModelManager; the class exists so a route
 * can be handed the surface it may use instead of the whole facade, and so
 * LumiscaCore stays a list of areas rather than a phone book of every call.
 */
export class ModelService {
  constructor(private readonly models: ModelManager) {}

  /** Providers with their models; the settings UI uses this to render
   * pickers. */
  listProviders(): readonly Provider[] {
    return this.models.getProviders();
  }

  listModels(providerId?: string): readonly Model<Api>[] {
    return this.models.getModels(providerId);
  }

  getModel(providerId: string, modelId: string): Model<Api> | undefined {
    return this.models.getModel(providerId, modelId);
  }

  /** Whether a provider's credentials are complete. */
  async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
    return await this.models.checkAuth(providerId);
  }

  /** Which credential method a provider accepts ("oauth", "api_key"), or
   * undefined for providers with only ambient auth (env vars etc.).
   * Static provider metadata — no credential required — so the settings UI
   * can offer a login button even before anything is configured. */
  getProviderAuthType(
    providerId: string,
  ): "oauth" | "api_key" | undefined {
    const provider = this.models.getProvider(providerId);
    if (!provider) return undefined;
    if (provider.auth.oauth) return "oauth";
    if (provider.auth.apiKey) return "api_key";
    return undefined;
  }

  /** Local (network-free) auth check: env var or stored key resolves.
   * This is the runtime capability check (can requests actually be
   * made); it deliberately includes ambient env auth, so it must not be
   * used to decide what the UI lists as configured — see
   * `hasConfiguredAuth`. */
  async hasProviderAuth(providerId: string): Promise<boolean> {
    return await this.models.hasProviderAuth(providerId);
  }

  /** Whether the provider is set up inside Lumisca itself: a stored API
   * key / OAuth credential, or a custom provider from Lumisca's own config
   * (models.json / LUMISCA_* env vars, a user-defined provider) whose auth
   * resolves. Ambient machine auth that the SDK happens to find — e.g.
   * ANTHROPIC_API_KEY or HF_TOKEN set for other tools — does NOT count:
   * providers must not appear as "added" just because an env var exists.
   * Also the gate for the default-model resolution and the UI's send
   * buttons: what the settings list calls "設定済み" must be exactly what
   * can be used. */
  async hasConfiguredAuth(providerId: string): Promise<boolean> {
    return await this.models.hasConfiguredAuth(providerId);
  }

  /** Enable or disable a model for the UI. Disabled models are hidden
   * from model pickers. Enabled is the default (nothing stored). */
  setModelEnabled(providerId: string, modelId: string, enabled: boolean): void {
    this.models.setModelEnabled(providerId, modelId, enabled);
  }

  isModelEnabled(providerId: string, modelId: string): boolean {
    return this.models.isModelEnabled(providerId, modelId);
  }

  /** Models of a provider with enablement info, for the settings UI. */
  listModelsDetailed(providerId: string): Array<{
    id: string;
    name: string;
    contextWindow?: number;
    maxInputTokens?: number;
    reasoning?: boolean;
    input?: string[];
    enabled: boolean;
    thinkingLevel: ThinkingLevel;
    thinkingLevels: ThinkingLevel[];
  }> {
    return this.models.getModels(providerId).map((m) => ({
      ...this.models.describeModel(m),
      enabled: this.isModelEnabled(providerId, m.id),
      ...this.models.thinkingState(providerId, m.id, m),
    }));
  }

  /** Every user-defined OpenAI-compatible provider (settings UI list).
   * The API key is never included — `hasApiKey` reports whether one is set. */
  async listUserProviders(): Promise<UserProviderSummary[]> {
    return await this.models.listUserProviders();
  }

  /** A single user-defined provider config (prefilling the edit form), or
   * undefined when it does not exist. */
  getUserProvider(id: string): UserProviderConfig | undefined {
    return this.models.getUserProvider(id);
  }

  /** Create a user-defined OpenAI-compatible provider. Validates, persists,
   * and registers it; an `apiKey` in the input is stored in the credential
   * store. Returns the summary. */
  async addUserProvider(
    input: UserProviderInput,
  ): Promise<UserProviderSummary> {
    return await this.models.addUserProvider(input);
  }

  /** Update a user-defined provider (id fixed by the route, matching the
   * path). An `apiKey` of "" clears the stored key; omitted leaves it. */
  async updateUserProvider(
    id: string,
    input: UserProviderInput,
  ): Promise<UserProviderSummary> {
    return await this.models.updateUserProvider(id, input);
  }

  /** Remove a user-defined provider and its stored API key. */
  async removeUserProvider(id: string): Promise<void> {
    await this.models.removeUserProvider(id);
  }

  /** Whether the provider was added by the user (the settings UI)
   * rather than built in or from the env/models.json custom config. */
  isUserProvider(id: string): boolean {
    return this.models.isUserProvider(id);
  }

  /** Where the active built-in model catalog came from (live fetch, disk
   * cache, or the bundled snapshot). */
  getModelCatalogStatus(): import("../models/mod.ts").CatalogStatus {
    return this.models.getCatalogStatus();
  }

  /** Refresh the built-in model catalog from models.dev (`live → cache →
   * snapshot`). Non-blocking by design: callers fire and forget at startup
   * and await it from the manual refresh UI/API. Never throws — the
   * resolved status (including `error`) is always returned. */
  refreshModelCatalog(
    options: {
      fetch?: typeof globalThis.fetch;
      timeoutMs?: number;
      baseUrl?: string;
    } = {},
  ): Promise<import("../models/mod.ts").CatalogStatus> {
    return this.models.refreshCatalog(options);
  }
}
