/**
 * The smallest shared store the UI needs, and the one shape every
 * cross-screen value uses.
 *
 * ARCHITECTURE.md's rule ("a value several screens read belongs in a
 * module-scope store; a value one screen owns stays in its own useState")
 * had three implementations: `settingsStore` and `modelCatalog` each brought
 * their own class, `i18n.ts` a bare `let` plus a listener set, and two more
 * values (the saved prompts, the connection registry) skipped the store
 * entirely and told each other to re-fetch through a `CustomEvent` on
 * `globalThis`. An event bus is not a store: nothing holds the value, so
 * every subscriber keeps its own copy and they drift between the moment one
 * writes and the moment another finishes reading.
 *
 * `createStore` is what those should have been. Subscribers are notified only
 * when `set` is called with a value that differs (`Object.is`), so a refresh
 * that produced the same data does not re-render anything.
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
