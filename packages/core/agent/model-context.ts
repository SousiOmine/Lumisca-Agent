/**
 * The model context provider: publishes which model this session is talking
 * to as a durable transcript message instead of baking it into the system
 * prompt.
 *
 * The model is the one environment fact that changes while a session lives.
 * A session can be switched to another model (the settings screen for code
 * mode, the conversation's own picker for stella), and a prompt that froze
 * the model at creation would keep telling the agent it is a model it no
 * longer runs on — a stale fact it may reason from ("I cannot see images")
 * long after it became false. Changing the prompt instead would cost the
 * provider's whole cached prefix on every switch, which is the one cost this
 * codebase is careful about everywhere (see ai/context-providers.ts).
 *
 * As a context message the fact is paid once, appended (never inserted), and
 * republished only when the model actually changed — the same shape as the
 * date (agent/date-context.ts) and the skill catalog (skills/catalog.ts).
 */

import type {
  ContextProvider,
  ContextUpdate,
} from "../ai/context-providers.ts";
import type { EnvironmentModel } from "../environment.ts";

/** Provider name of the model context. */
export const MODEL_PROVIDER = "model";

export interface ModelContextOptions {
  /** The model the session is using now, read before every run so a switch
   * reaches the next request without rebuilding the agent. Undefined when
   * the session's model is unknown (a caller that only has an id). */
  model: () => EnvironmentModel | undefined;
}

/** The label the prompt used to print: the catalog's name, else the ids. */
export function modelLabelOf(model: EnvironmentModel): string {
  return model.name ?? `${model.provider}/${model.modelId}`;
}

interface ModelState {
  label: string;
}

function labelOf(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const label = (state as ModelState).label;
  return typeof label === "string" ? label : undefined;
}

export function createModelProvider(
  options: ModelContextOptions,
): ContextProvider {
  /** The label of the last publication; undefined until the first one. */
  let published: string | undefined;

  return {
    name: MODEL_PROVIDER,
    next(): ContextUpdate[] {
      const model = options.model();
      // Nothing to announce when the caller cannot name the model: publishing
      // an empty line would be worse than the prompt's silence.
      if (model === undefined) return [];
      const label = modelLabelOf(model);
      if (published === label) return [];
      const replaced = published !== undefined;
      published = label;
      return [{
        title: `Model: ${label}`,
        body: `You are running on ${label}.${
          replaced
            ? " This replaces the earlier model: any statement you made " +
              "about your own capabilities before this message may no longer " +
              "apply."
            : ""
        }`,
        state: { label } satisfies ModelState,
      }];
    },
    rebase(state: unknown): void {
      published = labelOf(state);
    },
  };
}
