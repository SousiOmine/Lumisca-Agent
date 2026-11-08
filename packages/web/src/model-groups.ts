import type { ModelInfo, ProviderInfo } from "./types.ts";
import { filterByQuery } from "./providers.ts";
import { RECENT_MODEL_LIMIT, type RecentModel } from "./recentModels.ts";

/** One row of the model picker. The provider travels with the model because
 * the recent section mixes providers: a bare model id would not say which
 * machine answers, and two providers can publish the same id. */
export interface ModelPickerRow {
  provider: string;
  providerName: string;
  model: ModelInfo;
}

/** One section: the recent picks, or one provider's models. */
export interface ModelPickerGroup {
  /** `"recent"`, or the provider's id. Unique within the list. */
  key: string;
  kind: "recent" | "provider";
  /** The heading: the provider's name, or "" for the recent section (the
   * caller supplies that title from the message catalogue). */
  title: string;
  rows: ModelPickerRow[];
}

export interface ModelPickerList {
  groups: ModelPickerGroup[];
  /** Whether a query or the filters left nothing to draw: the difference
   * between "no model matches the search" and "no model can be used" is two
   * different sentences, and the picker needs both numbers to pick one. */
  empty: boolean;
  /** Models the catalog holds for these providers, before any filter. Zero
   * means there is nothing to offer at all (an empty catalog). */
  total: number;
  /** Models the filters let through, before the query. */
  listable: number;
}

export interface ModelListInput {
  /** Providers the picker offers, in catalog order. */
  providers: readonly Pick<ProviderInfo, "id" | "name">[];
  modelsByProvider: ReadonlyMap<string, ModelInfo[]>;
  /** The model in effect, or null when the caller's subject has none. */
  current: { provider: string; modelId: string } | null;
  /** Stored picks of the same peer, newest first. */
  recent: readonly RecentModel[];
  query: string;
  /** Hide models the user disabled in the settings. */
  enabledOnly: boolean;
  /** Hide models that take no image input. */
  imageOnly: boolean;
}

/**
 * The picker's one column, as sections: the recent picks first, then one
 * section per provider.
 *
 * The single list is what makes the panel the same on a phone and on a
 * desktop: nothing here depends on the room the panel got, and the reader
 * finds a model the same way on both (search, or the provider's heading).
 *
 * The recent section is a shortcut and nothing more. It holds the current
 * model first — a session restored from the server can run a model this
 * device never picked — then the stored picks, and it is filtered by the
 * same rules as the sections below, so it can never offer a model the
 * provider's own section hides.
 */
export function buildModelList(input: ModelListInput): ModelPickerList {
  const {
    providers,
    modelsByProvider,
    current,
    recent,
    query,
    enabledOnly,
    imageOnly,
  } = input;

  const listable = (providerId: string): ModelInfo[] => {
    const models = modelsByProvider.get(providerId) ?? [];
    return models.filter((m) =>
      (!enabledOnly || m.enabled !== false) &&
      (!imageOnly || m.input?.includes("image") === true)
    );
  };
  const matches = (model: ModelInfo): boolean =>
    filterByQuery([model], query).length > 0;

  const offered = new Map<string, ModelInfo[]>();
  const offeredIds = new Map<string, Set<string>>();
  let total = 0;
  let visible = 0;
  for (const provider of providers) {
    const models = listable(provider.id);
    offered.set(provider.id, models);
    offeredIds.set(provider.id, new Set(models.map((m) => m.id)));
    total += (modelsByProvider.get(provider.id) ?? []).length;
    visible += models.length;
  }

  const canOffer = (entry: RecentModel): boolean =>
    offeredIds.get(entry.provider)?.has(entry.modelId) === true;
  const ordered: RecentModel[] = [];
  if (current !== null && canOffer(current)) ordered.push(current);
  for (const entry of recent) {
    if (!canOffer(entry)) continue;
    if (
      ordered.some((m) =>
        m.provider === entry.provider && m.modelId === entry.modelId
      )
    ) {
      continue;
    }
    ordered.push(entry);
    if (ordered.length >= RECENT_MODEL_LIMIT) break;
  }

  const names = new Map(providers.map((p) => [p.id, p.name]));
  const groups: ModelPickerGroup[] = [];

  const recentRows: ModelPickerRow[] = [];
  for (const entry of ordered) {
    const model = offered.get(entry.provider)!.find((m) =>
      m.id === entry.modelId
    )!;
    if (!matches(model)) continue;
    recentRows.push({
      provider: entry.provider,
      providerName: names.get(entry.provider) ?? entry.provider,
      model,
    });
  }
  if (recentRows.length > 0) {
    groups.push({ key: "recent", kind: "recent", title: "", rows: recentRows });
  }

  for (const provider of providers) {
    const rows = offered.get(provider.id)!.filter(matches).map((model) => ({
      provider: provider.id,
      providerName: provider.name,
      model,
    }));
    if (rows.length === 0) continue;
    groups.push({
      key: provider.id,
      kind: "provider",
      title: provider.name,
      rows,
    });
  }

  return {
    groups,
    empty: groups.length === 0,
    total,
    listable: visible,
  };
}
