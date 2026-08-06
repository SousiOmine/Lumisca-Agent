import { builtinModels } from "npm:@earendil-works/pi-ai@0.83.0/providers/all";
import type {
  CredentialStore,
  Model,
  ModelsStore,
  ModelsStoreEntry,
  MutableModels,
  Provider,
} from "npm:@earendil-works/pi-ai@0.83.0";
import type { SettingsRepo } from "../settings/repo.ts";

const CATALOG_PREFIX = "model_catalog:";
const ENABLED_PREFIX = "model_enabled:";

/** Persistent model catalog cache stored in the settings table. */
export function createDbModelsStore(settings: SettingsRepo): ModelsStore {
  return {
    async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
      const raw = settings.get(`${CATALOG_PREFIX}${providerId}`);
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as ModelsStoreEntry;
      } catch {
        return undefined;
      }
    },
    async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
      settings.set(`${CATALOG_PREFIX}${providerId}`, JSON.stringify(entry));
    },
    async delete(providerId: string): Promise<void> {
      settings.delete(`${CATALOG_PREFIX}${providerId}`);
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

  getProviders() {
    return this.models.getProviders();
  }

  getModels(providerId?: string) {
    return this.models.getModels(providerId);
  }

  getModel(providerId: string, modelId: string): Model<any> | undefined {
    return this.models.getModel(providerId, modelId);
  }

  /** Models whose provider has complete auth configuration. */
  async getAvailable(providerId?: string) {
    return this.models.getAvailable(providerId);
  }

  async checkAuth(providerId: string) {
    return this.models.checkAuth(providerId);
  }

  /** Refresh dynamic provider catalogs (OpenRouter etc.). */
  async refresh(providerIds?: string[]): Promise<void> {
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
    return this.settings.get(`${ENABLED_PREFIX}${providerId}:${modelId}`) !== "0";
  }
}
