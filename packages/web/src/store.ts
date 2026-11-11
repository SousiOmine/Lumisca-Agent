import { useCallback, useSyncExternalStore } from "preact/compat";

/**
 * The UI's shared values: one store shape, and the loading it needs.
 *
 * ARCHITECTURE.md's rule is "a value several screens read belongs in a
 * module-scope store; a value one screen owns stays in its own useState".
 * That rule applied to five values (the settings, the model catalog, the saved
 * prompts, the connection registry, the user's providers) and produced five
 * implementations: two classes with their own listener sets, one bare `let`
 * plus a set, and three copies of the same single-flight bookkeeping
 * (`let reading: Promise<void> | null`). The copies were not equivalent —
 * only `settingsStore` suppressed a read that landed after a write, so a
 * toggle in one screen could be reverted by a refresh started before it.
 *
 * Two things live here, and nothing else:
 *
 * - {@link createStore}: one value and its subscribers, notified only when
 *   the value differs (a refresh that produced the same data renders nothing).
 * - {@link createResourceStore}: that store plus the bookkeeping every fetch
 *   needs — one request in flight shared by every caller, the `loading` and
 *   `error` state a screen draws, and the rule that a read which started
 *   before a write cannot overwrite it.
 */

/** One shared value and its subscribers. */
export interface Store<T> {
  /** The current value. */
  get(): T;
  /** Subscribe to changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Replace the value (a same-identity value notifies nobody). */
  set(next: T): void;
  /** Apply a change function to the current value. */
  update(fn: (current: T) => T): void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      notify();
    },
    update(fn) {
      this.set(fn(value));
    },
  };
}

/** What a fetched value's state always carries: whether a read is in flight,
 * whether one settled (a failure counts — waiting on a failed load forever is
 * the alternative), and the last failure. */
export interface ResourceStatus<E> {
  /** True while a read is in flight. */
  loading: boolean;
  /** True once a read settled, successfully or not. */
  loaded: boolean;
  /** The last read failure, or null. */
  error: E | null;
}

/** A resource store: the value, its loading state, and the calls that keep
 * it current. */
export interface ResourceStore<T, E> extends Store<T & ResourceStatus<E>> {
  /** Read the value. A call supersedes a read already in flight: the older
   * answer is discarded, because a caller that asked now wants the state as
   * of now. A read that started before a write cannot overwrite the write's
   * result either. */
  reload(): Promise<void>;
  /** Reflect a change the caller already committed, so every screen sees it
   * at once. Writes are counted: a read in flight when the change was
   * applied is discarded. */
  commit(next: T): void;
}

export interface ResourceOptions<T, E> {
  /** The value before the first read. */
  initial: T;
  /** Read the value. */
  load: () => Promise<T>;
  /** Whether two values are the same, for "this read changed nothing".
   * Defaults to `Object.is`; a resource whose value is rebuilt on every read
   * (an object, an array) passes a content comparison. */
  same?: (a: T, b: T) => boolean;
  /** Convert a thrown value into the state's error. Defaults to the message
   * of the thrown value (`String` for a non-Error). */
  describeError?: (error: unknown) => E;
}

export function createResourceStore<T, E = string>(
  options: ResourceOptions<T, E>,
): ResourceStore<T, E> {
  const same = options.same ?? Object.is;
  const describeError =
    options.describeError ?? ((error: unknown) => describeThrown(error) as E);
  let value: T & ResourceStatus<E> = {
    ...options.initial,
    loading: false,
    loaded: false,
    error: null,
  };
  const listeners = new Set<() => void>();
  /** True while a read is in flight: a subscriber mounting beside another
   * reuses it instead of issuing the same request again. An explicit
   * `reload()` ignores it and supersedes (see below). */
  let reading = false;
  /** Counts reads. A read records the count when it starts; a read whose
   * count moved has been superseded by a newer read, and its answer is
   * discarded. */
  let reads = 0;
  /** Writes applied so far. A read records the count it started at; landing
   * after a write means its answer predates that write. */
  let writes = 0;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  /** Publish `next` unless nothing changed: an equal refresh must not
   * re-render every subscriber (the tab-switch case the stores exist for). */
  const publish = (next: T & ResourceStatus<E>) => {
    if (
      value.loading === next.loading &&
      value.loaded === next.loaded &&
      value.error === next.error &&
      same(value, next)
    ) {
      return;
    }
    value = next;
    notify();
  };

  const store: ResourceStore<T, E> = {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      // A subscriber that mounts beside an in-flight read (two screens opening
      // together, a tab switching) reuses it: the same request for the same
      // answer is what this store exists to avoid.
      if (!value.loaded && !reading) void store.reload();
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      publish(next);
    },
    update(fn) {
      publish(fn(value));
    },
    reload() {
      const mine = ++reads;
      const writesAtStart = writes;
      reading = true;
      // Already loading with nothing to clear: publishing an equal state
      // would only cost an extra render.
      if (!value.loading || value.error !== null) {
        publish({ ...value, loading: true, error: null });
      }
      return (async () => {
        const stale = () => mine !== reads || writesAtStart !== writes;
        try {
          const loaded = await options.load();
          // Superseded by a newer read, or overtaken by a write: either way
          // this answer describes a state that is no longer current, and the
          // newer reader (or the write) has already published.
          if (stale()) return;
          publish({ ...loaded, loading: false, loaded: true, error: null });
        } catch (error) {
          if (stale()) return;
          publish({
            ...value,
            loading: false,
            loaded: true,
            error: describeError(error),
          });
        } finally {
          // Only the newest read owns the flag: an older one settling later
          // must not let a mount start a duplicate of the read in flight.
          if (mine === reads) reading = false;
        }
      })();
    },
    commit(next) {
      writes++;
      publish({ ...next, loading: false, loaded: true, error: null });
    },
  };
  return store;
}

/** The message of a thrown value (an unknown catch clause cannot assume an
 * Error). */
function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Subscribe a component to a store.
 *
 * The three lines this wraps (`useCallback` around `subscribe`, then
 * `useSyncExternalStore`) were copied verbatim into every store's hook —
 * four copies, each one a place to forget the `[]` dependency array and
 * re-subscribe on every render.
 */
export function useStore<T>(store: Store<T>): T {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  return useSyncExternalStore(subscribe, () => store.get());
}
