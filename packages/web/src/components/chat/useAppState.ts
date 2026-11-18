import type { UiAppState, UiAppStateStore } from "@lumisca/core/shared";
import { useSyncExternalStore } from "preact/compat";
import { useCallback } from "preact/hooks";

/** Subscribe one app card to its state store. The store replaces its root
 * on every change, so the snapshot identity is the render's cue. */
export function useAppState(store: UiAppStateStore): UiAppState {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  return useSyncExternalStore(subscribe, () => store.snapshot());
}
