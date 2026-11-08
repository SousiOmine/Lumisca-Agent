import {
  DEFAULT_MODEL_KEY,
  parseModelPreference,
  serializeModelPreference,
} from "@lumisca/core/shared";
import { settingsStore } from "./settingsStore.ts";

/**
 * Make `provider/modelId` the model a new conversation starts on.
 *
 * The new-session screen's picker writes here instead of keeping its choice
 * in component state: that screen is remounted on every tab switch and on
 * reload, so a value held there is gone before the session it was chosen for
 * exists. The settings dialog's "default model" row asks the same question,
 * and the server resolves a new session from that setting first, so both
 * surfaces read and write this one key and cannot disagree.
 *
 * Resolves without a request when the pair already is the default. Rejects
 * when the write fails, so the screen can say the choice was not remembered.
 */
export async function rememberDefaultModel(
  provider: string,
  modelId: string,
): Promise<void> {
  // `settingsStore.set` commits the state it holds and marks the table as
  // read, so a write before the first read would leave every other setting
  // looking unset to the panels that read this store. The read also answers
  // whether this pick changes anything.
  if (!settingsStore.get().loaded) await settingsStore.reload();
  const stored = parseModelPreference(settingsStore.value(DEFAULT_MODEL_KEY));
  if (stored?.provider === provider && stored.modelId === modelId) return;
  await settingsStore.set(
    DEFAULT_MODEL_KEY,
    serializeModelPreference({ provider, modelId }),
  );
}
