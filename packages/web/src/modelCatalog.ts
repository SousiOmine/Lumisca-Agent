import { errorMessage } from "@lumisca/core/shared";
import { modelApi } from "./api.ts";
import { createResourceStore, type ResourceStore } from "./store.ts";
import type { ModelInfo, ProviderInfo, ThinkingLevel } from "./types.ts";

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

/** Key of one model's committed values (see `ModelCatalog.localEnabled` and
 * `ModelCatalog.localThinking`). */
function modelKey(
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
 * that goes through the app must be written back here (`applyModelEnabled`,
 * `applyModelThinkingLevel`) rather than kept in the component that made it:
 * a component's local state dies with the component, and the next mount would
 * show the stale catalog again. */
export class ModelCatalog {
  private readonly stores = new Map<
    string,
    ResourceStore<PeerCatalog, CatalogFetchError>
  >();
  /** Committed `enabled` flags, by store key. A fetch issued before a flag
   * reached the server still carries the old value; applying that snapshot
   * verbatim would resurrect the pre-commit value (turning a visible toggle
   * back). The commit is therefore remembered and re-applied over every
   * fetched snapshot (`withLocalCommits`): the page's last explicit choice
   * is the value the user expects to see. */
  private readonly localEnabled = new Map<string, boolean>();
  /** Committed thinking levels, remembered for the same reason: the level is
   * shown by the composer, the settings list and the agent edit dialog, and
   * each of them reads this catalog rather than its own copy. */
  private readonly localThinking = new Map<string, ThinkingLevel>();

  constructor(private readonly load: CatalogLoader = fetchPeerCatalog) {}

  /** The peer's current state. Stable between publishes, which is what
   * makes it usable as `useSyncExternalStore`'s snapshot. */
  state(peerId: string): PeerCatalogState {
    return this.store(peerId).get();
  }

  /** Subscribe to a peer's catalog; returns the unsubscribe function. The
   * first subscriber loads the peer, later ones reuse the settled result. */
  subscribe(peerId: string, listener: () => void): () => void {
    return this.store(peerId).subscribe(listener);
  }

  /** Re-fetch the peer's providers and models. Resolves when the fetch
   * settles (callers that only trigger it ignore the result). */
  reload(peerId: string): Promise<void> {
    return this.store(peerId).reload();
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
    this.localEnabled.set(modelKey(peerId, providerId, modelId), enabled);
    this.commitModel(
      peerId,
      providerId,
      modelId,
      (model) => ({ ...model, enabled }),
    );
  }

  /** Apply a thinking level the server accepted to the cached catalog, for
   * the same reason as the enabled flag: the control that shows it must read
   * the stored value on its next mount, and the page has no other copy of
   * it. The level belongs to the model, so it is keyed like the enablement
   * and survives a fetch issued before the change. */
  applyModelThinkingLevel(
    peerId: string,
    providerId: string,
    modelId: string,
    level: ThinkingLevel,
  ): void {
    this.localThinking.set(modelKey(peerId, providerId, modelId), level);
    this.commitModel(
      peerId,
      providerId,
      modelId,
      (model) => ({ ...model, thinkingLevel: level }),
    );
  }

  /** Patch one cached model and publish. A model the cache does not have is
   * not an error: the catalog may not be loaded yet, and the remembered
   * commit applies on the next fetch. */
  private commitModel(
    peerId: string,
    providerId: string,
    modelId: string,
    patch: (model: ModelInfo) => ModelInfo,
  ): void {
    const state = this.store(peerId).get();
    const models = state.modelsByProvider.get(providerId);
    if (models === undefined || !models.some((m) => m.id === modelId)) return;
    const modelsByProvider = new Map(state.modelsByProvider);
    modelsByProvider.set(
      providerId,
      models.map((m) => (m.id === modelId ? patch(m) : m)),
    );
    this.store(peerId).commit({ providers: state.providers, modelsByProvider });
  }

  /** Re-apply the committed values (see `localEnabled` and `localThinking`)
   * over a fetched model map. Returns the input map unchanged when there is
   * nothing to patch. */
  private withLocalCommits(
    peerId: string,
    modelsByProvider: ReadonlyMap<string, ModelInfo[]>,
  ): ReadonlyMap<string, ModelInfo[]> {
    let out: Map<string, ModelInfo[]> | undefined;
    for (const [providerId, models] of modelsByProvider) {
      let patched: ModelInfo[] | undefined;
      for (const [index, model] of models.entries()) {
        const key = modelKey(peerId, providerId, model.id);
        const enabled = this.localEnabled.get(key);
        const thinkingLevel = this.localThinking.get(key);
        const next: ModelInfo = {
          ...model,
          ...(enabled === undefined ? {} : { enabled }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        };
        if (
          next.enabled === model.enabled &&
          next.thinkingLevel === model.thinkingLevel
        ) {
          continue;
        }
        patched ??= [...models];
        patched[index] = next;
      }
      if (patched !== undefined) {
        out ??= new Map(modelsByProvider);
        out.set(providerId, patched);
      }
    }
    return out ?? modelsByProvider;
  }

  /** One peer's store, created on first use. Peers are few and long-lived,
   * so entries are never evicted. */
  private store(
    peerId: string,
  ): ResourceStore<PeerCatalog, CatalogFetchError> {
    let store = this.stores.get(peerId);
    if (store === undefined) {
      store = createResourceStore<PeerCatalog, CatalogFetchError>({
        initial: { providers: [], modelsByProvider: new Map() },
        load: async () => {
          const catalog = await this.load(peerId);
          return {
            providers: catalog.providers,
            modelsByProvider: this.withLocalCommits(
              peerId,
              catalog.modelsByProvider,
            ),
          };
        },
        // Every read rebuilds both maps, so compare them by content: a
        // catalog that did not change must not re-render its consumers.
        same: sameCatalog,
        describeError: toCatalogFetchError,
      });
      this.stores.set(peerId, store);
    }
    return store;
  }
}

/** Two catalogs are the same when the provider list and every model list
 * match: a re-read that produced the same catalog renders nothing. */
function sameCatalog(a: PeerCatalog, b: PeerCatalog): boolean {
  if (
    a.providers === b.providers && a.modelsByProvider === b.modelsByProvider
  ) {
    return true;
  }
  if (a.providers.length !== b.providers.length) return false;
  for (const [index, provider] of a.providers.entries()) {
    if (provider.id !== b.providers[index]?.id) return false;
  }
  if (a.modelsByProvider.size !== b.modelsByProvider.size) return false;
  for (const [providerId, models] of a.modelsByProvider) {
    const other = b.modelsByProvider.get(providerId);
    if (other === undefined || other.length !== models.length) return false;
    for (const [index, model] of models.entries()) {
      const counterpart = other[index];
      if (counterpart === undefined) return false;
      if (
        model.id !== counterpart.id || model.enabled !== counterpart.enabled ||
        model.name !== counterpart.name ||
        model.thinkingLevel !== counterpart.thinkingLevel ||
        !sameLevels(model.thinkingLevels, counterpart.thinkingLevels)
      ) {
        return false;
      }
    }
  }
  return true;
}

/** Whether two level lists are the same (both may be absent). */
function sameLevels(
  a: readonly ThinkingLevel[] | undefined,
  b: readonly ThinkingLevel[] | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.length === b.length && a.every((level, index) => level === b[index]);
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
