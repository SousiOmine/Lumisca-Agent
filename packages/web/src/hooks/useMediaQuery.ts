import { useSyncExternalStore } from "preact/compat";

/** The width at or below which the layout switches to the single-column
 * phone layout. Must match the `@media (max-width: 600px)` blocks in
 * styles/ (the breakpoints are listed in styles/tokens.css and guarded by
 * styles_test.ts). */
export const PHONE_QUERY = "(max-width: 600px)";

/** A pointer without hover (a finger). Must match the
 * `@media (hover: none), (pointer: coarse)` blocks in styles/, which carry
 * the ergonomics a hover-only interaction cannot be re-styled into — the
 * rest of it (tap targets, 16px fields) is pure CSS. */
export const TOUCH_QUERY = "(hover: none), (pointer: coarse)";

/** The live value of one media query. */
interface MediaQueryStore {
  subscribe: (onChange: () => void) => () => void;
  /** The current match. The same MediaQueryList is reused so a re-render
   * does not build a new one (`useSyncExternalStore` calls this on every
   * render). */
  get: () => boolean;
}

function createStore(query: string): MediaQueryStore {
  const listeners = new Set<() => void>();
  let media: MediaQueryList | null = null;
  const notify = () => {
    // Copy first: a listener may unsubscribe while it is being called.
    for (const listener of [...listeners]) listener();
  };
  const queryList = (): MediaQueryList | null => {
    if (typeof matchMedia !== "function") return null;
    media ??= matchMedia(query);
    return media;
  };
  return {
    subscribe: (onChange) => {
      const list = queryList();
      if (list === null) return () => {};
      // One engine listener per query, however many components subscribe:
      // the store is shared (see queryStore), so `listeners` counts mounted
      // subscribers rather than matchMedia objects.
      if (listeners.size === 0) list.addEventListener("change", notify);
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) list.removeEventListener("change", notify);
      };
    },
    get: () => queryList()?.matches ?? false,
  };
}

/** One store per query, so every component asking for the same query shares
 * a subscription (and gets a stable `subscribe` identity, which
 * `useSyncExternalStore` requires to avoid re-subscribing on every
 * render). */
const stores = new Map<string, MediaQueryStore>();

function queryStore(query: string): MediaQueryStore {
  let store = stores.get(query);
  if (store === undefined) {
    store = createStore(query);
    stores.set(query, store);
  }
  return store;
}

/** Whether a media query matches, re-rendering the component when it flips.
 * `useSyncExternalStore` yields the value on the first render (no
 * effect-then-flash), which is what a mount-time decision such as "start
 * collapsed on a phone" needs. An environment without matchMedia (a test
 * renderer) reports false. */
export function useMediaQuery(query: string): boolean {
  const store = queryStore(query);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Whether the viewport is at phone width (see {@link PHONE_QUERY}): the
 * progress panels start collapsed there, so the transcript is not covered by
 * cards the user did not ask for. */
export function useNarrowViewport(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

/** Whether the input device is a finger (see {@link TOUCH_QUERY}): used by
 * the folder browser, where a double click — the desktop way to open a
 * folder — has no reliable touch equivalent. */
export function useTouchInput(): boolean {
  return useMediaQuery(TOUCH_QUERY);
}
