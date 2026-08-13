import { useCallback, useEffect, useState } from "react";
import { api, modelApi } from "./api.ts";
import { splitTabKey } from "./tabs.ts";
import type {
  ModelInfo,
  ProviderInfo,
  SessionView,
  ThinkingLevel,
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
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(reload, []);
  return { providers, error, reload };
}

/** Error of a useProviderModels fetch, tagged with the phase that failed
 * so callers can phrase their messages. */
export interface ProviderModelsError {
  phase: "providers" | "models";
  message: string;
}

export interface UseProviderModelsResult {
  /** Every provider of the peer ("" = this server), configured or not;
   * callers filter with `configured !== false` when they only want
   * authenticated ones. */
  providers: ProviderInfo[];
  /** Models of every provider, keyed by provider id; fetched in one batch
   * (empty until the fetch settles). */
  modelsByProvider: ReadonlyMap<string, ModelInfo[]>;
  /** True while providers/models are being fetched. */
  loading: boolean;
  /** Fetch failure (providers or models); null when the last fetch
   * succeeded. */
  error: ProviderModelsError | null;
  /** Re-fetch providers and models. */
  reload: () => void;
}

/** Providers → models of a peer ("" = this server) with a stale guard
 * (only the latest fetch may write state), loading/error, and reload.
 * Shared by the model picker, the settings model list and the model
 * preference panel so the fetch bookkeeping never varies. */
export function useProviderModels(peerId = ""): UseProviderModelsResult {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<
    Map<string, ModelInfo[]>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ProviderModelsError | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const ps = await modelApi(peerId).listProviders();
        if (stale) return;
        setProviders(ps);
        if (ps.length === 0) {
          setModelsByProvider(new Map());
          setLoading(false);
          return;
        }
        try {
          const entries = await Promise.all(
            ps.map(async (p) =>
              [p.id, await modelApi(peerId).listModels(p.id)] as const
            ),
          );
          if (stale) return;
          setModelsByProvider(new Map(entries));
        } catch (e) {
          if (!stale) setError({ phase: "models", message: errorText(e) });
        } finally {
          if (!stale) setLoading(false);
        }
      } catch (e) {
        if (!stale) {
          setError({ phase: "providers", message: errorText(e) });
          setLoading(false);
        }
      }
    })();
    return () => {
      stale = true;
    };
  }, [peerId, reloadSeq]);

  const reload = useCallback(() => setReloadSeq((s) => s + 1), []);
  return { providers, modelsByProvider, loading, error, reload };
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

/** Human-readable error string, used across every async UI surface. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
