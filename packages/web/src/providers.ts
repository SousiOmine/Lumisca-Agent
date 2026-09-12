import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "preact/compat";
import { errorMessage as errorText } from "@lumisca/core/shared";
import { api, modelApi } from "./api.ts";
import { modelCatalog, type PeerCatalogState } from "./modelCatalog.ts";
import { splitTabKey } from "./tabs.ts";
import type {
  ProviderInfo,
  SessionView,
  ThinkingLevel,
  UserProviderSummary,
} from "./types.ts";

/** Load the provider list once; `reload()` re-fetches. Failures are
 * surfaced separately so callers can tell "no providers configured" apart
 * from "server unreachable". */
export function useProviders(): {
  providers: ProviderInfo[];
  error: string | null;
  reload: () => void;
} {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = () => {
    setError(null);
    api.listProviders()
      .then(setProviders)
      .catch((e) => setError(errorText(e)));
  };
  useEffect(reload, []);
  return { providers, error, reload };
}

/** User-defined OpenAI-compatible providers (the settings UI manages these).
 * The API key is never returned — `hasApiKey` reports whether one is set. */
export function useUserProviders(): {
  providers: UserProviderSummary[];
  error: string | null;
  reload: () => void;
  /** Set of user provider ids, for quick membership checks (e.g. showing a
   * delete button in ProviderDetail). */
  ids: Set<string>;
} {
  const [providers, setProviders] = useState<UserProviderSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setError(null);
    api.listUserProviders()
      .then(setProviders)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(reload, [reload]);
  return {
    providers,
    error,
    reload,
    ids: new Set(providers.map((p) => p.id)),
  };
}

/** One peer's catalog ("" = this server) plus a reload trigger. */
export type UseProviderModelsResult = PeerCatalogState & {
  /** Re-fetch providers and models. */
  reload: () => void;
};

/** Providers → models of a peer ("" = this server) with a stale guard
 * (only the latest fetch may write state), loading/error, and reload.
 * Shared by the model picker, the settings model list and the model
 * preference panel so the fetch bookkeeping never varies.
 *
 * The state lives in the catalog store keyed by peer (see modelCatalog.ts):
 * the chat view and the model picker inside its composer both mount this
 * hook for the same peer, and each tab switch remounts the chat view, so a
 * per-mount fetch would re-request the same catalog several times per page
 * load. */
export function useProviderModels(peerId = ""): UseProviderModelsResult {
  const subscribe = useCallback(
    (listener: () => void) => modelCatalog.subscribe(peerId, listener),
    [peerId],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => modelCatalog.state(peerId),
  );
  const reload = useCallback(() => {
    void modelCatalog.reload(peerId);
  }, [peerId]);
  return { ...state, reload };
}

/** Persist a model's enabled flag (an app setting of this server: the
 * settings UI has no peer switcher) and apply it to the catalog store, so
 * the settings list and every model picker follow at once — and still show
 * it when they remount, since they read the store rather than a per-mount
 * copy. The store is patched optimistically and reverted when the save
 * fails, so a failed toggle never sticks. */
export async function setModelEnabled(
  providerId: string,
  modelId: string,
  enabled: boolean,
): Promise<void> {
  modelCatalog.applyModelEnabled("", providerId, modelId, enabled);
  try {
    await api.setModelEnabled(providerId, modelId, enabled);
  } catch (error) {
    modelCatalog.applyModelEnabled("", providerId, modelId, !enabled);
    throw error;
  }
}

/** Set the thinking level of a model on the peer that owns the session
 * ("" = this server) and return the stored level. Shared by every caller
 * (App, the draft tab, the settings panel) so the response is applied the
 * same way everywhere. */
export async function setModelThinkingLevel(
  peerId: string,
  provider: string,
  modelId: string,
  level: ThinkingLevel,
): Promise<ThinkingLevel> {
  const { thinkingLevel } = await modelApi(peerId).setThinkingLevel(
    provider,
    modelId,
    level,
  );
  return thinkingLevel;
}

/** Apply a stored thinking level to every open view whose session runs
 * the model on the given peer (the level is a per-model server setting,
 * so all sessions using it stay in sync). Returns the input map when
 * nothing changed, a new map otherwise. */
export function syncThinkingLevelInViews(
  views: Map<string, SessionView>,
  peerId: string,
  provider: string,
  modelId: string,
  thinkingLevel: ThinkingLevel,
): Map<string, SessionView> {
  const next = new Map(views);
  let changed = false;
  for (const [id, v] of next) {
    if (splitTabKey(id).peerId !== peerId) continue;
    if (v.info.modelProvider !== provider || v.info.modelId !== modelId) {
      continue;
    }
    if (v.info.thinkingLevel === thinkingLevel) continue;
    next.set(id, { ...v, info: { ...v.info, thinkingLevel } });
    changed = true;
  }
  return changed ? next : views;
}

/** Case-insensitive substring filter on id/name; empty query returns all. */
export function filterByQuery<T extends { id: string; name?: string }>(
  items: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter(
    (m) =>
      m.id.toLowerCase().includes(q) ||
      (m.name ?? "").toLowerCase().includes(q),
  );
}

/** Human-readable error string, used across every async UI surface (the
 * canonical helper lives in the core). */
export { errorText };
