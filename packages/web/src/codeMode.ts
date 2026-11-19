import { CODE_MODE_ENABLED_KEY } from "@lumisca/core/shared";
import { settingsStore } from "./settingsStore.ts";
import { createStore, useStore } from "./store.ts";

/**
 * Whether this installation offers code mode (settings → 実験的機能).
 *
 * The answer decides what the app may DRAW: the app menu's switch, whether a
 * `/code` address is a screen, and which mode a bare `/` starts in. It has to
 * be known before the first render, so the server sends it with the page
 * (`InitialData.codeModeEnabled`); the store is seeded from that answer in
 * client.tsx, and a settings write updates it in the same tick as the
 * settings table so every surface follows the switch without a reload.
 *
 * The server's API is not gated by this value: the switch is about what the
 * app offers a reader, not about removing code mode's endpoints.
 */
const store = createStore(false);

/** Seed the store from the server's bootstrap data, before the first render
 * (client.tsx). */
export function initCodeMode(enabled: boolean): void {
  store.set(enabled);
}

/** Whether code mode is offered, as a hook for components. */
export function useCodeModeEnabled(): boolean {
  return useStore(store);
}

/**
 * Persist the experimental switch and apply it.
 *
 * Optimistic like the other settings switches: the mode is offered or not the
 * moment the toggle moves, and a rejected write restores the previous answer
 * (the settings store restores its own value the same way). The write goes
 * through the settings table because the server owns the value; the store is
 * what the app's surfaces read.
 */
export async function setCodeModeEnabled(enabled: boolean): Promise<void> {
  const previous = store.get();
  store.set(enabled);
  try {
    await settingsStore.set(CODE_MODE_ENABLED_KEY, enabled ? "1" : "");
  } catch (error) {
    store.set(previous);
    throw error;
  }
}
