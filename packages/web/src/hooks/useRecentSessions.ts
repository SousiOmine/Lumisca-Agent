import { useCallback, useEffect, useRef, useState } from "preact/compat";
import { api, fed } from "../api.ts";
import { describeError, useT } from "../i18n.ts";
import { peerLabel } from "../peers.ts";
import { tabKey } from "../tabs.ts";
import type { PeerStatus, SessionInfo } from "../types.ts";
import { NEVER, useVisibleInterval } from "./useVisibleInterval.ts";

/** How often the list is re-read while a surface showing it is visible.
 *
 * The list says what this server and its peers last wrote, and all of it
 * changes without this page: another window, another device, a routine, or a
 * session created on a peer. None of those is an event this page receives,
 * and the relative times in the rows ("3分前") move on their own clock as
 * well, so re-reading is the only way the list stays true.
 *
 * 30s is the interval the other lists use (a stella agent's rows, the
 * revision probe), and it is as fast as the row times need: they are shown
 * in minutes. Shorter would multiply the cost of the peer probe, which asks
 * every registered peer `/api/health` (3s each, see routes/federation.ts)
 * before their session lists are read. */
const RECENT_REFRESH_MS = 30_000;

/** One row of the recent-sessions list: the tab key plus the data shown in
 * the row (the peer that owns the session, "" = this server). */
export interface RecentSessionItem {
  key: string;
  info: SessionInfo;
  peerId: string;
  peerName: string;
}

/** Recent sessions across this server and every reachable federated peer,
 * newest first, kept current while a surface shows them. Shared by the
 * session list modal (AppMenu) and the recent sessions section of the
 * new-session screen.
 *
 * Each instance owns its own read: the two surfaces can be on screen at
 * once (the modal covers the draft screen), and a read is cheap enough that
 * sharing it through a store would buy nothing but a second lifetime to
 * manage.
 *
 * `error` is the last failure and is cleared only by a successful read, so
 * one bad tick does not replace the rows with an error line: the rows the
 * reader can act on stay, with the failure stated above them. `loading`
 * covers the first read only — from then on the list has something to show,
 * and flipping it per refresh would only repaint the same rows.
 *
 * `enabled` is false while the surface reading the list is not on screen (the
 * draft tab's pane, kept mounted behind another tab — see
 * components/SessionPane). A tick probes every registered peer, so a list
 * nobody is looking at must not keep asking; coming back reads once.
 */
export function useRecentSessions(options: { enabled?: boolean } = {}): {
  items: RecentSessionItem[];
  loading: boolean;
  error: string | undefined;
  reload: () => void;
} {
  const [items, setItems] = useState<RecentSessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  /** Failures are described in the language the list is read in when they
   * happen (the state holds a string, not a failure object), and the read is
   * re-created when the language changes so a later tick speaks the new one. */
  const t = useT();
  /** A read is in flight. Ticks and presses that arrive meanwhile are
   * dropped rather than queued: the answer on its way was asked for less
   * than one interval ago, and letting a second read race it would let the
   * older answer win (a slow peer's list arriving after a newer one). */
  const inFlight = useRef(false);
  const disposed = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
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
      if (disposed.current) return;
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
        return [...merged.values()].sort(
          (a, b) => b.info.updatedAt - a.info.updatedAt,
        );
      });
      const remote = await Promise.all(
        probe
          .filter((p) => p.ok)
          .map((p) => {
            // The row label of a peer's session: the registry name, its host
            // when the name field is empty, the id as the last resort.
            const peerName = peerLabel(p, p.id);
            return fed.listSessions(p.id).then(
              (list) => ({ peerId: p.id, peerName, list }),
              () => ({ peerId: p.id, peerName, list: [] as SessionInfo[] }),
            );
          }),
      );
      if (disposed.current) return;
      const merged: RecentSessionItem[] = [
        ...localItems,
        ...remote.flatMap(({ peerId, peerName, list }) =>
          rows(list, peerId, peerName),
        ),
      ].sort((a, b) => b.info.updatedAt - a.info.updatedAt);
      setItems(merged);
      setError(undefined);
    } catch (failure) {
      // This server itself could not be reached; what the list holds is the
      // last answer, which the surface shows under this line.
      if (!disposed.current) setError(describeError(failure, t));
    } finally {
      inFlight.current = false;
      if (!disposed.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    disposed.current = false;
    void load();
    return () => {
      disposed.current = true;
    };
  }, [load]);

  // Nothing runs while the page is hidden (see useVisibleInterval), and
  // coming back to it reads at once: the list the reader returns to is the
  // one they left, and the answer is one request away. A list whose surface is
  // behind another tab is not polled at all.
  const enabled = options.enabled !== false;
  useVisibleInterval(() => void load(), enabled ? RECENT_REFRESH_MS : NEVER, {
    immediate: false,
  });

  // A surface that comes back reads once, the same way a freshly mounted one
  // does: it may have been behind another tab for as long as the reader was
  // away, and a session created meanwhile (here or on a peer) has to appear.
  // The mount itself is not this path — `load` already ran in the effect above
  // — so a visible surface reads once, not twice.
  const wasEnabled = useRef(enabled);
  useEffect(() => {
    if (!enabled) {
      wasEnabled.current = false;
      return;
    }
    if (wasEnabled.current) return;
    wasEnabled.current = true;
    void load();
  }, [enabled, load]);

  /** Re-fetch now (the button beside a failed read). */
  const reload = useCallback(() => {
    void load();
  }, [load]);

  return { items, loading, error, reload };
}
