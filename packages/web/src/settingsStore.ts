import { useCallback, useSyncExternalStore } from "preact/compat";
import { api } from "./api.ts";

/**
 * The app's settings, as one shared store.
 *
 * Five screens used to fetch `GET /api/settings` independently and pick the
 * few keys they needed (the chat view's compaction hint, the safety toggle,
 * the compaction tuning, computer use, the model preferences). Each of those
 * fetches was a separate request per mount, and the chat view is remounted
 * whenever the active tab changes — so switching tabs re-read the whole
 * settings table each time. The catalog store (modelCatalog.ts) already
 * solved the same problem for providers and models; this is its settings
 * counterpart.
 *
 * The store answers `undefined` while the first read is in flight (callers
 * that need a value fall back to their documented default) and publishes a
 * new snapshot only when the values actually changed, so subscribers do not
 * re-render on an identical refresh.
 */
export interface SettingsState {
  /** The values the server exposes through the generic settings API
   * (credentials and the other privileged records are absent by design). */
  values: Readonly<Record<string, string>>;
  /** True once a read settled (success or failure). */
  loaded: boolean;
  /** Last read failure, or null. */
  error: string | null;
}

const EMPTY: SettingsState = { values: {}, loaded: false, error: null };

class SettingsStore {
  private state: SettingsState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private reading: Promise<void> | null = null;
  /** A write is in flight: a read that lands now would overwrite it with
   * the stale value the server had before. */
  private writing = 0;

  /** The current snapshot (stable between publishes). */
  get(): SettingsState {
    return this.state;
  }

  /** Subscribe; the first subscriber reads, later ones reuse the result. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (!this.state.loaded && this.reading === null) void this.reload();
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The value of one key, or undefined when it is unset or not loaded. */
  value(key: string): string | undefined {
    return this.state.values[key];
  }

  /** Re-read the settings. Concurrent calls share one request. */
  reload(): Promise<void> {
    if (this.reading !== null) return this.reading;
    const generation = this.writing;
    this.reading = (async () => {
      try {
        const values = await api.getSettings();
        if (generation !== this.writing) return;
        this.publish({ values, loaded: true, error: null });
      } catch (error) {
        this.publish({
          ...this.state,
          loaded: true,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.reading = null;
      }
    })();
    return this.reading;
  }

  /**
   * Write one setting and reflect it locally. The write goes through the
   * server exactly as before (the caller still handles its failure); the
   * local value is applied optimistically so a component that just toggled
   * something does not briefly show the old value, and dropped again when
   * the write fails.
   */
  async set(key: string, value: string): Promise<void> {
    const previous = this.state.values[key];
    this.writing++;
    this.publish({
      ...this.state,
      values: { ...this.state.values, [key]: value },
    });
    try {
      await api.setSetting(key, value);
    } catch (error) {
      const values = { ...this.state.values };
      if (previous === undefined) delete values[key];
      else values[key] = previous;
      this.publish({ ...this.state, values });
      throw error;
    } finally {
      this.writing--;
    }
  }

  /** Reset the store (tests). */
  reset(): void {
    this.state = EMPTY;
    this.reading = null;
    this.writing = 0;
    this.notify();
  }

  private publish(next: SettingsState): void {
    // Equal content is not a change: re-publishing would re-render every
    // subscriber for nothing (the tab-switch case this store exists for).
    if (
      sameValues(this.state.values, next.values) &&
      this.state.loaded === next.loaded &&
      this.state.error === next.error
    ) {
      return;
    }
    this.state = next;
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

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

/** The app's single settings store. */
export const settingsStore = new SettingsStore();

/** Settings state for components (re-renders when a value changes). */
export function useSettings(): SettingsState & {
  reload: () => void;
  set: (key: string, value: string) => Promise<void>;
} {
  const subscribe = useCallback(
    (listener: () => void) => settingsStore.subscribe(listener),
    [],
  );
  const state = useSyncExternalStore(subscribe, () => settingsStore.get());
  const reload = useCallback(() => {
    void settingsStore.reload();
  }, []);
  const set = useCallback(
    (key: string, value: string) => settingsStore.set(key, value),
    [],
  );
  return { ...state, reload, set };
}

/** One setting's value (undefined while unloaded or unset). */
export function useSetting(key: string): string | undefined {
  const subscribe = useCallback(
    (listener: () => void) => settingsStore.subscribe(listener),
    [],
  );
  const state = useSyncExternalStore(subscribe, () => settingsStore.get());
  return state.values[key];
}
