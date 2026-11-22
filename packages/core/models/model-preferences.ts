import type { Model } from "../ai/catalog.ts";
import type { Api } from "../domain/model.ts";
import type { SettingsRepo } from "../settings/repo.ts";
import {
  FAST_MODEL_KEY,
  IMAGE_MODEL_KEY,
  parseModelPreference,
} from "../shared/settings-keys.ts";

/**
 * The models the settings point at, by role: the image-analysis model and
 * the fast model. Both are a stored `provider/model` preference resolved
 * against the live catalog, so a model that left it resolves to undefined
 * (the caller then has no model for that role rather than a stale one).
 */
export class ModelPreferences {
  constructor(
    private readonly settings: SettingsRepo,
    private readonly getModel: (
      providerId: string,
      modelId: string,
    ) => Model<Api> | undefined,
  ) {}

  /** The configured image-analysis model (the `model_image` setting), or
   * undefined when unset or the model is no longer in the catalog. It
   * interprets images as text for sessions whose main model cannot see
   * them (see agent/image-analysis.ts). */
  imageAnalysisModel(): Model<Api> | undefined {
    const pref = parseModelPreference(this.settings.get(IMAGE_MODEL_KEY));
    if (pref === undefined) return undefined;
    return this.getModel(pref.provider, pref.modelId);
  }

  /** The configured fast model (the `model_fast` setting), or undefined
   * when unset or the model is no longer in the catalog. It generates
   * session titles from the first user message (see
   * agent/title-generation.ts) and runs sub-agents. */
  fastModel(): Model<Api> | undefined {
    return this.fastModelInfo()?.model;
  }

  /** The configured fast model with its provider/model ids, or undefined
   * when unset or the model is no longer in the catalog. Sub-agents (the
   * task tool) run on this model, with its stored thinking level. */
  fastModelInfo():
    | { provider: string; modelId: string; model: Model<Api> }
    | undefined {
    const pref = parseModelPreference(this.settings.get(FAST_MODEL_KEY));
    if (pref === undefined) return undefined;
    const model = this.getModel(pref.provider, pref.modelId);
    if (model === undefined) return undefined;
    return { provider: pref.provider, modelId: pref.modelId, model };
  }
}
