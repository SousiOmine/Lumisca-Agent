/**
 * The models this device picked recently, for the shortcut section at the
 * top of the model picker.
 *
 * Kept on the device rather than on the server: which model a reader
 * switches between is a habit of the screen in front of them (a phone and a
 * desktop of the same account do not share it), and the server has no use
 * for the list. The entries are only a shortcut — every model stays in its
 * provider's section below — so losing the list (private mode, a cleared
 * storage) costs nothing but the shortcut.
 */

/** One stored pick, newest first. */
export interface RecentModel {
  provider: string;
  modelId: string;
}

/**
 * Most picks one peer keeps. The section is a shortcut to the handful of
 * models a reader actually switches between; a longer list would push the
 * providers' own sections below the fold of the panel, which is the list
 * the picker was opened for.
 */
export const RECENT_MODEL_LIMIT = 5;

/** localStorage key, scoped per browser profile and origin like
 * `lumisca.appMode`: the list is this client's, not the server's. */
const KEY = "lumisca.recentModels";

/** Peer id → its picks. Peers are separate machines with separate catalogs,
 * so a model picked on one is not a model the other can run. */
export type StoredRecents = Record<string, RecentModel[]>;

/**
 * What a stored value says, discarding anything malformed.
 *
 * The value is not ours alone (an older version of the app, a hand-edited
 * profile), and a throw here would take the whole picker down: every entry
 * that is not a provider/modelId pair is skipped, duplicates are dropped and
 * each peer keeps at most {@link RECENT_MODEL_LIMIT}.
 */
export function parseStoredRecents(raw: string | null): StoredRecents {
  if (raw === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const stored: StoredRecents = {};
  for (const [peerId, entries] of Object.entries(value as StoredRecents)) {
    if (!Array.isArray(entries)) continue;
    const list: RecentModel[] = [];
    for (const entry of entries) {
      const { provider, modelId } = (entry ?? {}) as {
        provider?: unknown;
        modelId?: unknown;
      };
      if (typeof provider !== "string" || provider === "") continue;
      if (typeof modelId !== "string" || modelId === "") continue;
      if (list.some((m) => m.provider === provider && m.modelId === modelId)) {
        continue;
      }
      list.push({ provider, modelId });
      if (list.length >= RECENT_MODEL_LIMIT) break;
    }
    stored[peerId] = list;
  }
  return stored;
}

/** The stored picks of one peer, newest first. */
export function recentsOf(raw: string | null, peerId: string): RecentModel[] {
  return parseStoredRecents(raw)[peerId] ?? [];
}

/**
 * The stored value with `model` as the newest pick of `peerId`.
 *
 * A pick is moved to the front rather than added again: choosing the same
 * model twice must not fill the section with one row repeated.
 */
export function withRecentModel(
  raw: string | null,
  peerId: string,
  model: RecentModel,
): string {
  const stored = parseStoredRecents(raw);
  const kept = (stored[peerId] ?? []).filter(
    (m) => m.provider !== model.provider || m.modelId !== model.modelId,
  );
  const next = [model, ...kept].slice(0, RECENT_MODEL_LIMIT);
  return JSON.stringify({ ...stored, [peerId]: next });
}

/** localStorage, or null where there is none (a webview that refuses it). */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The picks this device made on `peerId`, newest first. */
export function recentModels(peerId: string): RecentModel[] {
  const store = storage();
  if (store === null) return [];
  try {
    return recentsOf(store.getItem(KEY), peerId);
  } catch {
    return [];
  }
}

/** Record a pick. Failures are ignored: the shortcut is not worth an error
 * in the panel, and the pick itself still goes through. */
export function rememberRecentModel(
  peerId: string,
  provider: string,
  modelId: string,
): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(
      KEY,
      withRecentModel(store.getItem(KEY), peerId, { provider, modelId }),
    );
  } catch {
    // A storage that refuses writes (private mode, a full quota) costs the
    // reader only the shortcut: every model is still listed below.
  }
}
