import { errorMessage } from "@lumisca/core/shared";
import { modelApi } from "./api.ts";
import type { ModelInfo, ProviderInfo } from "./types.ts";

/** Catalog fetch failure, tagged with the phase that broke so the UI can
 * phrase its message: "providers" means the provider list is unknown,
 * "models" means the providers arrived but their model lists did not. */
export class CatalogFetchError extends Error {
  constructor(readonly phase: "providers" | "models", message: string) {
    super(message);
    this.name = "CatalogFetchError";
  }
}

/** One peer's providers and their models (one fetch). */
export interface PeerCatalog {
  /** Every provider of the peer, configured or not; callers filter with
   * `configured !== false` when they only want authenticated ones. */
  providers: ProviderInfo[];
  /** Models of every provider, keyed by provider id. */
  modelsByProvider: ReadonlyMap<string, ModelInfo[]>;
}

/** One peer's catalog as published to subscribers. */
export interface PeerCatalogState extends PeerCatalog {
  /** True while providers/models are being fetched. */
  loading: boolean;
  /** Fetch failure; null when the last fetch succeeded. */
  error: CatalogFetchError | null;
}

/** Where a peer's catalog comes from. Injectable so the store can be
 * exercised without a server (tests); the default fetches over HTTP. */
export type CatalogLoader = (peerId: string) => Promise<PeerCatalog>;

/** Per-peer fetch bookkeeping. Peers are few and long-lived, so entries
 * are never evicted. */
interface Entry {
  state: PeerCatalogState;
  listeners: Set<() => void>;
  /** True once a fetch settled (success or failure). */
  loaded: boolean;
  /** True while a fetch is in flight. */
  fetching: boolean;
  /** Fetch generation: a response from a superseded fetch is dropped. */
  generation: number;
}

/** Store key of one model's enablement (see `ModelCatalog.localEnabled`). */
function enabledKey(
  peerId: string,
  providerId: string,
  modelId: string,
): string {
  return `${peerId}\u0000${providerId}\u0000${modelId}`;
}

/** The provider/model catalog of each peer, keyed by peer id ("" = this
 * server).
 *
 * It is the one place every catalog consumer reads (the settings model
 * list, the model pickers, the chat view): the state lives here rather than
 * per component, so mounting several consumers — and remounting one, e.g.
 * every time the settings dialog reopens or a tab switches — reuses the
 * settled fetch instead of re-requesting the same catalog.
 *
 * Because consumers read this store and not their own copy, every change
 * that goes through the app must be written back here (`applyModelEnabled`)
 * rather than kept in the component that made it: a component's local state
 * dies with the component, and the next mount would show the stale catalog
 * again. */
export class ModelCatalog {
  private readonly entries = new Map<string, Entry>();
  /** Committed `enabled` flags, by store key. A fetch issued before a flag
   * reached the server still carries the old value; applying that snapshot
   * verbatim would resurrect the pre-commit value (turning a visible toggle
   * back). The commit is therefore remembered and re-applied over every
   * fetched snapshot (`withLocalEnabled`): the page's last explicit choice
   * is the value the user expects to see. */
  private readonly localEnabled = new Map<string, boolean>();

  constructor(private readonly load: CatalogLoader = fetchPeerCatalog) {}

  /** The peer's current state. Stable between publishes, which is what
   * makes it usable as `useSyncExternalStore`'s snapshot. */
  state(peerId: string): PeerCatalogState {
    return this.entry(peerId).state;
  }

  /** Subscribe to a peer's catalog; returns the unsubscribe function. The
   * first subscriber loads the peer, later ones reuse the settled result. */
  subscribe(peerId: string, listener: () => void): () => void {
    const entry = this.entry(peerId);
    entry.listeners.add(listener);
    if (!entry.loaded && !entry.fetching) void this.reload(peerId);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  /** Re-fetch the peer's providers and models. Resolves when the fetch
   * settles (callers that only trigger it ignore the result). */
  async reload(peerId: string): Promise<void> {
    const entry = this.entry(peerId);
    const generation = ++entry.generation;
    entry.fetching = true;
    // Already loading with no error to clear: publishing an equal-content
    // object would only cost an extra render.
    if (!entry.state.loading || entry.state.error !== null) {
      this.publish(peerId, { ...entry.state, loading: true, error: null });
    }

    let patch: Partial<PeerCatalogState>;
    try {
      const catalog = await this.load(peerId);
      patch = {
        providers: catalog.providers,
        modelsByProvider: this.withLocalEnabled(
          peerId,
          catalog.modelsByProvider,
        ),
      };
    } catch (error) {
      patch = { error: toCatalogFetchError(error) };
    }
    // A newer fetch superseded this one: its result is authoritative.
    if (generation !== entry.generation) return;
    entry.fetching = false;
    entry.loaded = true;
    this.publish(peerId, {
      ...entry.state,
      loading: false,
      error: null,
      ...patch,
    });
  }

  /** Apply a model's committed `enabled` flag to the cached catalog, so
   * every consumer (settings list, model pickers) reflects it at once and a
   * later mount still shows it (see the class comment). The flag is also
   * remembered, so a fetch that was already on its way cannot undo it. When
   * the provider's models are not cached yet there is nothing to patch —
   * the next fetch applies the remembered flag. */
  applyModelEnabled(
    peerId: string,
    providerId: string,
    modelId: string,
    enabled: boolean,
  ): void {
    this.localEnabled.set(enabledKey(peerId, providerId, modelId), enabled);
    const entry = this.entry(peerId);
    const models = entry.state.modelsByProvider.get(providerId);
    if (models === undefined || !models.some((m) => m.id === modelId)) return;
    const modelsByProvider = new Map(entry.state.modelsByProvider);
    modelsByProvider.set(
      providerId,
      models.map((m) => m.id === modelId ? { ...m, enabled } : m),
    );
    this.publish(peerId, { ...entry.state, modelsByProvider });
  }

  /** Re-apply the committed flags (see `localEnabled`) over a fetched model
   * map. Returns the input map unchanged when there is nothing to patch. */
  private withLocalEnabled(
    peerId: string,
    modelsByProvider: ReadonlyMap<string, ModelInfo[]>,
  ): ReadonlyMap<string, ModelInfo[]> {
    let out: Map<string, ModelInfo[]> | undefined;
    for (const [providerId, models] of modelsByProvider) {
      let patched: ModelInfo[] | undefined;
      for (const [index, model] of models.entries()) {
        const committed = this.localEnabled.get(
          enabledKey(peerId, providerId, model.id),
        );
        if (committed === undefined || model.enabled === committed) continue;
        patched ??= [...models];
        patched[index] = { ...model, enabled: committed };
      }
      if (patched !== undefined) {
        out ??= new Map(modelsByProvider);
        out.set(providerId, patched);
      }
    }
    return out ?? modelsByProvider;
  }

  private entry(peerId: string): Entry {
    let entry = this.entries.get(peerId);
    if (entry === undefined) {
      entry = {
        state: {
          providers: [],
          modelsByProvider: new Map(),
          loading: true,
          error: null,
        },
        listeners: new Set(),
        loaded: false,
        fetching: false,
        generation: 0,
      };
      this.entries.set(peerId, entry);
    }
    return entry;
  }

  private publish(peerId: string, state: PeerCatalogState): void {
    const entry = this.entry(peerId);
    entry.state = state;
    // Copy first: a listener may unsubscribe while we notify.
    for (const listener of [...entry.listeners]) listener();
  }
}

/** Every catalog fetch of the app (the store's default loader). */
export const modelCatalog = new ModelCatalog();

/** Fetch one peer's providers and their models. The provider list and the
 * per-provider model lists are separate calls, so a failure is tagged with
 * the failing phase. */
async function fetchPeerCatalog(peerId: string): Promise<PeerCatalog> {
  const api = modelApi(peerId);
  let providers: ProviderInfo[];
  try {
    providers = await api.listProviders();
  } catch (error) {
    throw new CatalogFetchError("providers", errorMessage(error));
  }
  try {
    const fetched = await Promise.all(
      providers.map(async (p) => [p.id, await api.listModels(p.id)] as const),
    );
    return { providers, modelsByProvider: new Map(fetched) };
  } catch (error) {
    throw new CatalogFetchError("models", errorMessage(error));
  }
}

/** Normalize whatever a loader threw into the state's error shape. */
function toCatalogFetchError(error: unknown): CatalogFetchError {
  return error instanceof CatalogFetchError
    ? error
    : new CatalogFetchError("providers", errorMessage(error));
}
