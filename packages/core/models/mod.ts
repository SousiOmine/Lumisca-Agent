import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  Api,
  AuthCheck,
  CredentialStore,
  Model,
  ModelsStore,
  ModelsStoreEntry,
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import type { SettingsRepo } from "../settings/repo.ts";
import type { ThinkingLevel } from "../shared.ts";
import { loadCustomProviders } from "./custom.ts";
import { clampThinkingLevel } from "./thinking.ts";

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

  constructor(
    credentials: CredentialStore,
    settings: SettingsRepo,
    modelsStore?: ModelsStore,
  ) {
    this.models = builtinModels({ credentials, modelsStore }) as MutableModels;
    this.settings = settings;
    // Custom OpenAI-compatible providers (env vars / models.json) are
    // registered after the builtins. setProvider upserts by id, so:
    // - a models.json provider may intentionally replace a builtin
    //   provider of the same id (e.g. point "openai" at a compatible
    //   endpoint) — this is the override mechanism, not an accident;
    // - the env-var provider is registered last, so it wins collisions
    //   with models.json ids.
    for (const provider of loadCustomProviders()) {
      this.models.setProvider(provider);
    }
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

  async checkAuth(
    providerId: string,
  ): Promise<AuthCheck | undefined> {
    return await this.models.checkAuth(providerId);
  }

  /** Whether the provider resolves auth (env var or stored key) without a
   * network call. The pickers use this so unconfigured providers are not
   * offered; unlike checkAuth it never fails on a transient network error. */
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
