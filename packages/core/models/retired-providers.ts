import type { Model, Provider } from "../ai/catalog.ts";
import type { Api } from "../domain/model.ts";

/** A provider removed from the catalog, kept for the sessions that already
 * reference it: the provider itself (with its auth definition and headers)
 * and the models that disappeared with it.
 *
 * The whole provider is kept, not just its models: credential resolution runs
 * through `provider.resolveCredential`, so a stand-in without auth could
 * never resolve a stored key or an env var, and every retired session would
 * fail with "Provider is not configured" — the opposite of what keeping the
 * provider alive is for. */
interface RetiredProvider {
  /** The provider as it was: id, name, baseUrl, headers and auth. */
  provider: Provider;
  /** The models that went away with it (or with an update), by id. */
  models: Map<string, Model<Api>>;
}

/**
 * The catalog entries a refresh removed, kept resolvable for the sessions
 * that already name them. Listings and new-session resolution never read
 * this: a tombstone is reachable only through the ids a session carries.
 */
export class RetiredProviders {
  private readonly entries = new Map<string, RetiredProvider>();

  /** Remember a removed provider (with its auth and headers) and its models
   * before it leaves the registry. A provider with no models leaves nothing
   * a session could reference, so it is not kept. */
  retain(provider: Provider): void {
    if (provider.getModels().length === 0) return;
    const kept = this.entry(provider.id, provider);
    for (const model of provider.getModels()) kept.models.set(model.id, model);
  }

  /** Remember the models a provider update dropped (same provider id, model
   * gone upstream). Models still present are refreshed out of the retired
   * set so a re-added model resolves to its live form, not the tombstone. */
  retainRemovedModels(previous: Provider, next: Provider): void {
    const liveIds = new Set(next.getModels().map((m) => m.id));
    let kept = this.entries.get(previous.id);
    for (const model of previous.getModels()) {
      if (liveIds.has(model.id)) {
        kept?.models.delete(model.id);
        continue;
      }
      kept = this.entry(previous.id, previous);
      kept.models.set(model.id, model);
    }
    if (kept !== undefined && kept.models.size === 0) {
      this.entries.delete(previous.id);
    }
  }

  providerOf(providerId: string): Provider | undefined {
    return this.entries.get(providerId)?.provider;
  }

  modelOf(providerId: string, modelId: string): Model<Api> | undefined {
    return this.entries.get(providerId)?.models.get(modelId);
  }

  has(providerId: string, modelId: string): boolean {
    return this.entries.get(providerId)?.models.has(modelId) === true;
  }

  /** The retired entry of a provider, created on first use. The FIRST
   * provider seen for an id wins: it is the one a live session was built
   * against, so its baseUrl, headers and auth are the ones that keep working
   * (a later refresh cannot rewrite the connection a session relies on). */
  private entry(providerId: string, provider: Provider): RetiredProvider {
    const existing = this.entries.get(providerId);
    if (existing !== undefined) return existing;
    const created: RetiredProvider = {
      provider,
      models: new Map(),
    };
    this.entries.set(providerId, created);
    return created;
  }
}
