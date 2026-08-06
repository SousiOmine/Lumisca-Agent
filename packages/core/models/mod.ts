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

const CATALOG_PREFIX = "model_catalog:";
const ENABLED_PREFIX = "model_enabled:";

/** Persistent model catalog cache stored in the settings table. */
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
    extraProviders: Provider[] = [],
  ) {
    this.models = builtinModels({ credentials, modelsStore }) as MutableModels;
    this.settings = settings;
    for (const provider of extraProviders) {
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

  /** Models whose provider has complete auth configuration. */
  async getAvailable(
    providerId?: string,
  ): Promise<readonly Model<Api>[]> {
    return await this.models.getAvailable(providerId);
  }

  async checkAuth(
    providerId: string,
  ): Promise<AuthCheck | undefined> {
    return await this.models.checkAuth(providerId);
  }

  /** Refresh dynamic provider catalogs (OpenRouter etc.). */
  async refresh(_providerIds?: string[]): Promise<void> {
    await this.models.refresh({ force: true, allowNetwork: true });
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
}
