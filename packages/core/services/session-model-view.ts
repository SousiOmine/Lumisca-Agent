/**
 * A session's model, as every client-facing shape publishes it.
 *
 * Four call sites assembled the same block by hand: the session decoration,
 * the model list of the settings screen, the thinking state of one session
 * and the default model of a new one. Each picked its own subset, so a client
 * could be told a thinking level without the levels the model supports, or a
 * model's metadata without the level it runs at. This is the one place that
 * decides what those blocks contain.
 */

import type { Model } from "../ai/catalog.ts";
import type { Api } from "../domain/model.ts";
import type { ThinkingLevel } from "../shared/mod.ts";
import type { ModelInfo } from "../shared/providers.ts";

/** The reads the thinking half of a session's model view needs. */
export interface SessionThinkingSource {
  /** The catalog entry, or undefined when the model is gone. */
  getSessionModel(provider: string, modelId: string): Model<Api> | undefined;
  /** The stored level and the levels the model supports. */
  thinkingState(
    provider: string,
    modelId: string,
    model: Model<Api> | undefined,
  ): { thinkingLevel: ThinkingLevel; thinkingLevels: ThinkingLevel[] };
}

/** The reads the whole model view needs: the thinking half plus the catalog
 * metadata. */
export interface SessionModelSource extends SessionThinkingSource {
  /** The catalog metadata, shaped for the UI. */
  describeModel(model: Model<Api>): ModelInfo;
}

/** The thinking part of a session's model view. */
export interface SessionThinking {
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
}

/** Everything a client is told about the model a session runs on. */
export interface SessionModelView extends SessionThinking {
  /** The catalog metadata; absent when the model is not in the catalog. */
  model?: ModelInfo;
}

/** The thinking state of `provider`/`modelId` (see
 * SessionModelSource.thinkingState). */
export function sessionThinking(
  source: SessionThinkingSource,
  provider: string,
  modelId: string,
): SessionThinking {
  return source.thinkingState(
    provider,
    modelId,
    source.getSessionModel(provider, modelId),
  );
}

/** The whole model view of a session (see the module comment). */
export function sessionModelView(
  source: SessionModelSource,
  provider: string,
  modelId: string,
): SessionModelView {
  const model = source.getSessionModel(provider, modelId);
  return {
    ...source.thinkingState(provider, modelId, model),
    ...(model !== undefined ? { model: source.describeModel(model) } : {}),
  };
}
