import { useCallback, useEffect, useState } from "react";
import { api, fed } from "../api.ts";
import type { PeerStatus, SessionInfo } from "../types.ts";
import { errorText } from "../providers.ts";
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
      // Peer reachability comes from the same federated workspace list the
      // picker uses; unreachable peers contribute no sessions. A peer that
      // fails its own list adds nothing instead of failing the whole load.
      let peers: PeerStatus[] = [];
      try {
        peers = (await fed.workspaces()).peers;
      } catch {
        // The federated list is unavailable; the local sessions below still
        // apply.
      }
      const [local, ...remote] = await Promise.all([
        api.listSessions(),
        ...peers.filter((p) => p.ok).map((p) =>
          fed.listSessions(p.id).then(
            (list) => ({ peerId: p.id, peerName: p.name, list }),
            () => (
              { peerId: p.id, peerName: p.name, list: [] as SessionInfo[] }
            ),
          )
        ),
      ]);
      const merged: RecentSessionItem[] = [
        ...local.map((info) => ({
          key: tabKey("", info.id),
          info,
          peerId: "",
          peerName: "",
        })),
        ...remote.flatMap(({ peerId, peerName, list }) =>
          list.map((info) => ({
            key: tabKey(peerId, info.id),
            info,
            peerId,
            peerName,
          }))
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
