import { useCallback } from "preact/compat";
import { api } from "./api.ts";
import { createResourceStore, useStore } from "./store.ts";

/**
 * The app's settings, as one shared store.
 *
 * Five screens used to fetch `GET /api/settings` independently and pick the
 * few keys they needed (the chat view's compaction hint, the safety toggle,
 * the compaction tuning, computer use, the model preferences). Each of those
 * fetches was a separate request per mount, and the chat view is remounted
 * whenever the active tab changes — so switching tabs re-read the whole
 * settings table each time.
 *
 * The store answers `undefined` while the first read is in flight (callers
 * that need a value use their documented default) and publishes a new
 * snapshot only when the values actually changed, so subscribers do not
 * re-render on an identical refresh.
 */
export interface SettingsState {
  /** The values the server exposes through the generic settings API
   * (credentials and the other privileged records are absent by design). */
  values: Readonly<Record<string, string>>;
}

const store = createResourceStore<SettingsState, string>({
  initial: { values: {} },
  load: async () => ({ values: await api.getSettings() }),
  same: (a, b) => sameValues(a.values, b.values),
});

/** The app's single settings store. */
export const settingsStore = {
  get: () => store.get(),
  subscribe: (listener: () => void) => store.subscribe(listener),

  /** The value of one key, or undefined when it is unset or not loaded. */
  value(key: string): string | undefined {
    return store.get().values[key];
  },

  /** Re-read the settings. Concurrent calls share one request. */
  reload: () => store.reload(),

  /**
   * Write one setting and reflect it locally. The write goes through the
   * server as before (the caller handles its failure); the local value is
   * applied optimistically so a component that just toggled something does
   * not briefly show the old value, and dropped again when the write fails.
   *
   * The commit also discards a read that was already in flight: it carries
   * the value the server had before this write.
   */
  async set(key: string, value: string): Promise<void> {
    const previous = store.get().values[key];
    store.commit({
      values: { ...store.get().values, [key]: value },
    });
    try {
      await api.setSetting(key, value);
    } catch (error) {
      const values = { ...store.get().values };
      if (previous === undefined) delete values[key];
      else values[key] = previous;
      store.commit({ values });
      throw error;
    }
  },

  /** Reset the store (tests). */
  reset(): void {
    store.commit({ values: {} });
  },
};

/** Whether two settings maps hold the same keys and values: a refresh that
 * changed nothing must not re-render every subscriber (the tab-switch case
 * this store exists for). */
function sameValues(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** Settings state for components (re-renders when a value changes). */
export function useSettings(): SettingsState & {
  loaded: boolean;
  error: string | null;
  reload: () => void;
  set: (key: string, value: string) => Promise<void>;
} {
  const state = useStore(store);
  const reload = useCallback(() => {
    void store.reload();
  }, []);
  const set = useCallback(
    (key: string, value: string) => settingsStore.set(key, value),
    [],
  );
  return { ...state, reload, set };
}

/** One setting's value (undefined while unloaded or unset). */
export function useSetting(key: string): string | undefined {
  return useStore(store).values[key];
}
