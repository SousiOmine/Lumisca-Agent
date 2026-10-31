import { useCallback, useEffect, useState } from "preact/compat";
import { api, fed } from "../api.ts";
import type { PeerStatus, SessionInfo } from "../types.ts";
import { errorText } from "../providers.ts";
import { peerLabel } from "../peers.ts";
import { tabKey } from "../tabs.ts";

/** One row of the recent-sessions list: the tab key plus the data shown in
 * the row (the peer that owns the session, "" = this server). */
export interface RecentSessionItem {
  key: string;
  info: SessionInfo;
  peerId: string;
  peerName: string;
}

/** Recent sessions across this server and every reachable federated peer,
 * newest first. Shared by the session list modal (AppMenu) and the recent
 * sessions section of the new-session screen. */
export function useRecentSessions(): {
  items: RecentSessionItem[];
  loading: boolean;
  error: string | undefined;
  reload: () => void;
} {
  const [items, setItems] = useState<RecentSessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      // Peer reachability comes from the federation's peer probe;
      // unreachable peers contribute no sessions. A peer that fails its own
      // list adds nothing instead of failing the whole load.
      //
      // The probe and this server's own list run together: the local
      // sessions are the ones that are always there, and a peer on a slow
      // link must not make the whole list wait for it (the probe answers
      // per machine, so the answer arrives with the slowest peer).
      const [local, probe] = await Promise.all([
        api.listSessions(),
        fed.peers().then(
          (result) => result.peers,
          () => [] as PeerStatus[],
        ),
      ]);
      // This server's rows are shown as soon as they arrive: a peer's list
      // is a second, optional round trip, and while it is in flight the list
      // is still usable (the remote rows are added a moment later).
      const rows = (list: SessionInfo[], peerId: string, peerName: string) =>
        list.map((info) => ({
          key: tabKey(peerId, info.id),
          info,
          peerId,
          peerName,
        }));
      const localItems = rows(local, "", "");
      setItems((prev) => {
        const merged = new Map(prev.map((row) => [row.key, row]));
        for (const row of localItems) merged.set(row.key, row);
        return [...merged.values()].sort((a, b) =>
          b.info.updatedAt - a.info.updatedAt
        );
      });
      const remote = await Promise.all(
        probe.filter((p) => p.ok).map((p) => {
          // The row label of a peer's session: the registry name, its host
          // when the name field is empty, the id as the last resort.
          const peerName = peerLabel(p, p.id);
          return fed.listSessions(p.id).then(
            (list) => ({ peerId: p.id, peerName, list }),
            () => ({ peerId: p.id, peerName, list: [] as SessionInfo[] }),
          );
        }),
      );
      const merged: RecentSessionItem[] = [
        ...localItems,
        ...remote.flatMap(({ peerId, peerName, list }) =>
          rows(list, peerId, peerName)
        ),
      ].sort((a, b) => b.info.updatedAt - a.info.updatedAt);
      setItems(merged);
    } catch (e) {
      // This server itself could not be reached; the list is unusable.
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, nonce]);

  /** Re-fetch (the list is stale once a session is closed or deleted). */
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { items, loading, error, reload };
}
