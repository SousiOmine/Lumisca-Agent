import type { Model } from "../ai/catalog.ts";
import type { Api } from "../domain/model.ts";
import type { SettingsRepo } from "../settings/repo.ts";
import type { ThinkingLevel } from "../shared/mod.ts";
import { MODEL_THINKING_PREFIX } from "../shared/settings-keys.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "./thinking.ts";

/**
 * The thinking level a model stores, and the levels it may carry.
 *
 * Clamping happens here rather than at the call sites so the stored value and
 * the value reported back cannot disagree: every read returns what a request
 * will actually ask the model for, and every write stores only that. The
 * rules themselves (which levels a model supports, where an unsupported one
 * lands) are thinking.ts.
 */
export class ThinkingStore {
  constructor(
    private readonly settings: SettingsRepo,
    /** Resolve a model by ids, including a retired one (see
     * CatalogStore.getModelWithRetired): a session keeps streaming at its
     * stored level after the model leaves the catalog. */
    private readonly modelWithRetired: (
      providerId: string,
      modelId: string,
    ) => Model<Api> | undefined,
  ) {}

  /** The stored thinking level of a model, clamped to what it supports.
   * "off" is the default when nothing is stored. Retired models keep
   * their own stored level (their tombstone carries the last live
   * thinking map), so existing sessions stream with the same level. */
  get(providerId: string, modelId: string): ThinkingLevel {
    const model = this.modelWithRetired(providerId, modelId);
    const stored = this.settings.get(key(providerId, modelId));
    return clampThinkingLevel(model, (stored as ThinkingLevel) ?? "off");
  }

  /** The thinking state the UI renders for one model: the stored level and
   * the levels the model supports ("off" alone when the model is unknown).
   * `modelId` is the caller's own id (a session keeps its ids after the
   * model is retired), `model` the catalog entry when one is known. */
  state(
    providerId: string,
    modelId: string,
    model: Model<Api> | undefined,
  ): { thinkingLevel: ThinkingLevel; thinkingLevels: ThinkingLevel[] } {
    return {
      thinkingLevel: this.get(providerId, modelId),
      thinkingLevels: getSupportedThinkingLevels(model),
    };
  }

  /** Store a thinking level for a model. Unsupported levels are clamped to
   * the nearest supported one; "off" removes the entry (the default).
   * Returns the level that will actually be used. Retired models resolve
   * through their tombstone so existing sessions can still tune them. */
  set(
    providerId: string,
    modelId: string,
    level: ThinkingLevel,
  ): ThinkingLevel {
    const model = this.modelWithRetired(providerId, modelId);
    const effective = clampThinkingLevel(model, level);
    const storageKey = key(providerId, modelId);
    if (effective === "off") {
      this.settings.delete(storageKey);
    } else {
      this.settings.set(storageKey, effective);
    }
    return effective;
  }
}

function key(providerId: string, modelId: string): string {
  return `${MODEL_THINKING_PREFIX}${providerId}:${modelId}`;
}
