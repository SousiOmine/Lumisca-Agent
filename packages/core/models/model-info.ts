import type { Model } from "../ai/catalog.ts";
import type { Api } from "../domain/model.ts";
import type { ModelInfo } from "../shared/mod.ts";

/** The catalog metadata of one model, shaped for the UI (context window,
 * reasoning flag, input modalities). The session decoration and the detailed
 * model list both publish this block, so clients see one shape. */
export function describeModel(model: Model<Api>): ModelInfo {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxInputTokens: model.maxInputTokens,
    reasoning: model.reasoning,
    input: model.input,
  };
}
