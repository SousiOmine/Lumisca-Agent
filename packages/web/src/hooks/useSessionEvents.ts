import { useCallback, useEffect, useRef, useState } from "preact/compat";
import { connectEvents, sessionApi, type SessionSnapshot } from "../api.ts";
import { errorText } from "../providers.ts";
import {
  applyEvent,
  applySnapshot,
  revisionGap,
  type SnapshotParts,
} from "../events.ts";
import { keysForPeer, tabKey } from "../tabs.ts";
import { maybeNotifyAgentEnd, maybeNotifyQuestion } from "../notify.ts";
import type { ClientEvent, SessionView, TodoPhase } from "../types.ts";

/** Period between opportunistic state re-syncs while the WebSocket is
 * disconnected (see syncState). While the socket is up the events are the
 * live source; a tab returning to the foreground is the only other moment
 * a re-sync runs. */
const DISCONNECTED_SYNC_INTERVAL_MS = 10_000;

/** Period between revision probes of the open tabs while connected: one
 * tiny request per tab, and a snapshot re-read only when a revision moved
 * (see the probe in useSessionEvents). Catches events that were emitted but
 * never arrived — a socket that died without a close event, a peer's relay
 * gap — within one interval instead of at the next reconnect. */
const REVISION_PROBE_MS = 30_000;

/** Event-stream reconnect backoff: 2s → 4s → 8s … capped at 30s. */
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

/** Fetch one session's panel snapshots — the parts of a view that are not in
 * the transcript snapshot: the sub-agent tasks, the background commands and
 * the active goal. Each piece is fetched independently (one failing — a
 * deleted session, an unreachable peer — must not drop the others), and a
 * failed piece is absent rather than empty, so the caller keeps what it
 * shows. Panels only, so a caller that merges the result never touches the
 * transcript or the live state (see events.applySnapshot). Undefined when
 * every piece failed: there is nothing to apply. */
async function fetchPanels(id: string): Promise<SnapshotParts | undefined> {
  const session = sessionApi(id);
  const panels: SnapshotParts = {};
  let fetched = false;
  try {
    panels.tasks = (await session.getTasks()).tasks;
    fetched = true;
  } catch {
    // Server not reachable yet; keep the current tasks.
  }
  try {
    panels.backgrounds = (await session.getBackground()).backgrounds;
    fetched = true;
  } catch {
    // Server not reachable yet; keep the current backgrounds.
  }
  try {
    panels.goal = (await session.getGoal()).goal;
    fetched = true;
  } catch {
    // Server not reachable yet; keep the current goal.
  }
  return fetched ? panels : undefined;
}

/** The display name of a session this page has no tab for — one that was
 * left running ("close and keep running", see CloseTabsDialog) or one it
 * never opened. Only the server knows the title, and the session id an event
 * carries is not a name a user recognizes, so the notification path reads
 * the title on demand. Best-effort: a session that is gone (or a peer that
 * is unreachable) falls back to the id, which is what notifications named
 * before. */
async function detachedSessionName(key: string): Promise<string> {
  const session = sessionApi(key);
  try {
    return (await session.getSession()).name;
  } catch {
    return session.sessionId;
  }
}

/** Session views plus the WebSocket event stream that feeds them:
 * reconnect with resync on drop, state sync while disconnected and on
 * tab-return, revision-based gap detection and probing while connected, and
 * per-view error recording. The returned setViews is shared with the tab
 * and session action logic, and seedRevision lets the tab paths (which
 * apply a snapshot themselves) seed the revision marker of a restored tab;
 * resyncPanels fetches the panel snapshots of a single tab (a tab reopened
 * on a session whose run is still going has them missing).
 * `onConnectionLost` fires on every WS close (the desktop health monitor
 * uses it to arm its server-down banner); `onConnectionOpen` fires on every
 * (re)connect. */
export function useSessionEvents(
  options: {
    onConnectionLost?: () => void;
    onConnectionOpen?: () => void;
  } = {},
) {
  const [views, setViews] = useState<Map<string, SessionView>>(new Map());
  const viewsRef = useRef(views);
  // Per-tab revision marker: the last event count this client has accounted
  // for (seeded from a snapshot, advanced by every event). A frame whose
  // count skips ahead means frames were lost, and a probe that reads a
  // higher count than this means events never arrived — both re-read the
  // snapshot (see handleEvent and the probe below). Refs, not view state:
  // tracking must not re-render, and every event updates it.
  const revsRef = useRef(new Map<string, number>());
  // Ref writes happen in an effect: writing during render breaks under
  // concurrent rendering. The WS event handler reads the ref, so it always
  // sees the latest views.
  useEffect(() => {
    viewsRef.current = views;
  }, [views]);

  /** Seed one tab's revision marker from the snapshot its view was built
   * from. The tab restore and reopen paths apply such a snapshot themselves
   * (useTabs), outside syncState: without this, a tab restored from a
   * snapshot would start watching for lost frames only after its next full
   * sync. A marker is never lowered — an event that arrived meanwhile is
   * newer than the snapshot it raced. */
  const seedRevision = useCallback((key: string, rev: number) => {
    const known = revsRef.current.get(key);
    if (known === undefined || rev > known) revsRef.current.set(key, rev);
  }, []);

  /** Re-fetch the session snapshot (the transcript plus the live state the
   * event stream cannot restore: run state, pending questions, last error,
   * title), the todo plan, the task snapshots, and the background-command
   * snapshots for every open tab — or only for `keys`, which the
   * peer-stream recovery uses to re-read just the peer that came back —
   * and merge them in without duplicating what is already shown. Runs on
   * reconnect, on a short interval while the socket is down, and when a
   * connected tab returns to the foreground, so a run that completes while
   * the socket was down — and todo/task/background mutations whose snapshot
   * events were lost — are not missed until the next WS drop. The todo plan
   * is a snapshot fetch (the events only fire on mutations), so the fetched
   * state replaces the view's plan wholesale; tasks merge per agent id so
   * live deltas are preserved. The snapshot also carries the server's run
   * state, which is what tells a view that (re)connected mid-run that the
   * run is still going — `agent_start` is never replayed (see
   * applyRunState). */
  const syncState = useCallback(async (keys?: string[]) => {
    const ids = keys ?? [...viewsRef.current.keys()];
    // The live state as it stood when the fetch started. An event that
    // changes a piece while the snapshot is in flight is newer than the
    // snapshot, so that piece must not be applied on top (a run that just
    // ended must not be resurrected by a snapshot read a moment earlier,
    // and a question that just arrived must not be dropped by one). A tab
    // that closed since the call has no entry: its snapshot is applied
    // wholesale (and the view is gone anyway).
    const stateBefore = new Map<string, {
      started: number | undefined;
      ended: number | undefined;
      questions: SessionView["pendingQuestions"];
      handover: SessionView["pendingHandover"];
      error: string | undefined;
      name: string;
    }>();
    for (const id of ids) {
      const v = viewsRef.current.get(id);
      if (v === undefined) continue;
      stateBefore.set(id, {
        started: v.agentStartedAt,
        ended: v.agentEndedAt,
        questions: v.pendingQuestions,
        handover: v.pendingHandover,
        error: v.error,
        name: v.info.name,
      });
    }
    const snapshots = new Map<string, SessionSnapshot>();
    const todos = new Map<string, TodoPhase[]>();
    const panels = new Map<string, SnapshotParts>();
    await Promise.all(ids.map(async (id) => {
      // Fetch independently: one failing (e.g. the session was deleted)
      // must not drop the other.
      try {
        snapshots.set(id, await sessionApi(id).getMessages());
      } catch {
        // Server not reachable yet; keep the current transcript.
      }
      try {
        const { todos: plan } = await sessionApi(id).getTodo();
        todos.set(id, plan);
      } catch {
        // Server not reachable yet; keep the current plan.
      }
      const entry = await fetchPanels(id);
      if (entry !== undefined) panels.set(id, entry);
    }));
    // Seed the revision marker of every session whose snapshot arrived: a
    // later gap (or probe) can then tell whether this view has seen
    // everything.
    for (const [id, snapshot] of snapshots) {
      seedRevision(id, snapshot.rev);
    }
    if (snapshots.size === 0 && todos.size === 0 && panels.size === 0) {
      return;
    }
    setViews((prev) => {
      // Nothing changed keeps the map's identity (so App does not re-render
      // on a sync that learned nothing new).
      let next: Map<string, SessionView> | null = null;
      for (const id of ids) {
        // The rules (live state wins over the snapshot, panels merge or
        // replace, nothing changed keeps the view's identity) live in
        // events.applySnapshot, where they are unit-tested.
        const v = (next ?? prev).get(id);
        if (v === undefined) continue;
        const nextView = applySnapshot(
          v,
          {
            ...panels.get(id),
            snapshot: snapshots.get(id),
            todos: todos.get(id),
          },
          stateBefore.get(id),
        );
        if (nextView === v) continue;
        next ??= new Map(prev);
        next.set(id, nextView);
      }
      return next ?? prev;
    });
  }, [seedRevision]);

  /** Re-read one open tab's panel snapshots (sub-agent tasks, background
   * commands, goal) and merge them in. Asked for when a tab is opened on a
   * session whose run is still going — a session left running with "close
   * and keep running" and reopened from the session history: the transcript
   * snapshot does not carry the panels, and the task/background events only
   * update rows that are already there, so a background command running
   * since before the reopen would stay invisible until the next resync.
   * Panels only, so the live state a run may have changed meanwhile is never
   * overwritten (see events.applySnapshot). */
  const resyncPanels = useCallback(async (key: string) => {
    const panels = await fetchPanels(key);
    if (panels === undefined) return;
    setViews((prev) => {
      const v = prev.get(key);
      if (v === undefined) return prev;
      const nextView = applySnapshot(v, panels, undefined);
      if (nextView === v) return prev;
      const next = new Map(prev);
      next.set(key, nextView);
      return next;
    });
  }, [setViews]);

  /** Clear per-session transient state (stuck streaming/tool indicators)
   * and re-fetch the session snapshot and the panel snapshots, so nothing
   * is lost after a WS drop. The run state, the pending questions and the
   * last error are deliberately kept: this view cannot tell what happened
   * while the socket was down, and clearing them is what used to leave a
   * live run rendered as 作業完了 (and a pending question unanswerable)
   * until the next `agent_start`. syncState reconciles all of them from the
   * server's answer (the snapshot carries them). */
  const resync = useCallback(async () => {
    setViews((prev) => {
      const next = new Map(prev);
      for (const [id, v] of next) {
        next.set(id, {
          ...v,
          streamingText: "",
          runningTools: new Map(),
          thinkingStartAt: undefined,
        });
      }
      return next;
    });
    await syncState();
  }, [syncState]);

  /** Apply a WS event to the matching session view (pure reducer). Events
   * carry the peer id ("" = this server); the tab key resolves the view.
   * Session events also carry the emitting server's revision, which is what
   * detects a lost frame without another round trip.
   *
   * `agent_end` and `question` events additionally arm an OS notification
   * when the app is hidden (the notify module decides): the reducer below
   * must stay the single writer of view state, so notification sends are
   * fire-and-forget and never block or reorder the state update. */
  const handleEvent = useCallback(
    (event: ClientEvent & { peerId?: string; rev?: number }) => {
      if (event.type === "session_created") return;
      // A peer's relay came back: the sessions watched through it may have
      // missed events while it was down (the peer's own stream drops are
      // invisible otherwise), so re-read their snapshots — and only theirs.
      // The gap announcement (`connected: false`) needs no reaction: the
      // views keep what they have until the relay is back.
      if (event.type === "peer_stream") {
        if (event.connected) {
          const keys = keysForPeer(viewsRef.current.keys(), event.peerId);
          if (keys.length > 0) void syncState(keys);
        }
        return;
      }
      const key = tabKey(event.peerId ?? "", event.sessionId);
      // A revision that skips ahead means frames were lost (a socket that
      // died without a close event, a peer's relay gap): this tab's view
      // cannot be trusted, so re-read its snapshot. Only the client's own
      // open tabs are tracked — the stream carries every session's events,
      // and the first frame of an untracked session only seeds the marker
      // (nothing was expected before it).
      if (event.rev !== undefined && viewsRef.current.has(key)) {
        const known = revsRef.current.get(key);
        if (revisionGap(known, event.rev)) {
          void syncState([key]);
        }
        revsRef.current.set(key, event.rev);
      }
      if (event.type === "agent_end" || event.type === "question") {
        const view = viewsRef.current.get(key);
        // A notification for a session with no open tab must still name it:
        // the title then comes from the server, and only if the toast is
        // actually shown (see notify.SessionName).
        const name: string | (() => Promise<string>) = view?.info.name ??
          (() => detachedSessionName(key));
        if (event.type === "agent_end") {
          // A duplicate delivery (same run's end seen twice) must not
          // notify twice: the first end stamps agentEndedAt, and only a
          // new agent_start clears it for the next run.
          if (view?.agentEndedAt === undefined) {
            void maybeNotifyAgentEnd(name);
          }
        } else {
          // Same dedup contract as the reducer's pendingQuestions: a
          // re-delivered question (same tool call) notifies once.
          if (
            !view?.pendingQuestions.some((q) =>
              q.toolCallId === event.toolCallId
            )
          ) {
            void maybeNotifyQuestion(name, event.questions);
          }
        }
      }
      setViews((prev) => {
        const target = prev.get(key);
        if (!target) return prev;
        const nextView = applyEvent(event, target);
        if (nextView === null || nextView === target) return prev;
        const next = new Map(prev);
        next.set(key, nextView);
        return next;
      });
    },
    [syncState],
  );

  /** Record an error on a session view (no-op when the tab is gone). The
   * key is the composite tab key (peerId:sessionId). */
  const setViewError = useCallback((key: string, error: unknown) => {
    setViews((prev) => {
      const current = prev.get(key);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(key, { ...current, error: errorText(error) });
      return next;
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let syncTimer: ReturnType<typeof setInterval> | undefined;
    let disconnect: (() => void) | undefined;
    let reconnectAttempts = 0;
    // Whether the event stream is currently connected. While it is up the
    // events are the live source; while it is down a short-interval sync
    // covers everything (see syncState). The flags live in this effect's
    // closure — it runs once (all callbacks are stable) — and are updated
    // from the connectEvents onOpen/onClose callbacks.
    let connected = false;

    const stopSyncTimer = () => {
      if (syncTimer !== undefined) {
        clearInterval(syncTimer);
        syncTimer = undefined;
      }
    };
    const startSyncTimer = () => {
      if (syncTimer !== undefined) return;
      syncTimer = setInterval(() => {
        syncState();
      }, DISCONNECTED_SYNC_INTERVAL_MS);
    };

    // While connected, verify on a low interval that this view has seen
    // every event of its open tabs (see revsRef): one tiny request per tab,
    // and a snapshot re-read only when a count moved. A socket that died
    // without a close event, or a peer relay gap, is then noticed within an
    // interval instead of at the next reconnect.
    const probeTimer = setInterval(async () => {
      if (disposed || !connected) return;
      for (const key of [...revsRef.current.keys()]) {
        if (!viewsRef.current.has(key)) continue;
        try {
          const { rev } = await sessionApi(key).getRevision();
          if (disposed) return;
          // The marker may have moved while the request was in flight (an
          // event arrived): compare against the fresh value.
          if (rev !== revsRef.current.get(key)) void syncState([key]);
        } catch {
          // Opportunistic: a failed probe is not a state change. The
          // socket's own liveness is the heartbeat watchdog's business.
        }
      }
    }, REVISION_PROBE_MS);

    /** Cancel any pending reconnect and close the existing socket, so
     * connect() always starts from a clean slate (prevents double-open). */
    const cleanup = () => {
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      disconnect?.();
      disconnect = undefined;
    };

    /** Schedule the next reconnect with exponential backoff. */
    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== undefined) return;
      const delay = Math.min(
        RECONNECT_BASE_MS * 2 ** reconnectAttempts,
        RECONNECT_MAX_MS,
      );
      reconnectAttempts++;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    // Opportunistic sync: a run that finishes entirely inside a disconnect
    // window — or a todo mutation whose snapshot event was lost — would
    // otherwise only appear at the next reconnect. While connected the WS
    // delivers the events, so a tab returning to the foreground is the
    // only moment a missed state gets re-synced (the interval covers the
    // disconnected case).
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (connected) {
        syncState();
      } else {
        // Tab returns to foreground while disconnected: try to reconnect
        // immediately instead of waiting for the backoff timer.
        if (reconnectTimer !== undefined) {
          clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
        }
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const connect = () => {
      // Ensure any existing connection and pending reconnect are torn down
      // before opening a new one, so the socket is always singular.
      cleanup();
      if (disposed) return;
      disconnect = connectEvents(
        handleEvent,
        () => {
          // On close: clear stuck state and re-sync, then reconnect.
          if (disposed) return;
          connected = false;
          // The server may be gone (not just the socket): arm the desktop
          // health monitor so its banner can classify and offer restart.
          options.onConnectionLost?.();
          startSyncTimer();
          resync();
          scheduleReconnect();
        },
        () => {
          // On (re)open: re-sync state (events emitted while the socket
          // was down are merged in) and stop the fallback interval — the
          // stream is the live source again. Reset the backoff counter.
          connected = true;
          reconnectAttempts = 0;
          stopSyncTimer();
          options.onConnectionOpen?.();
          resync();
        },
      );
    };
    connect();

    return () => {
      disposed = true;
      cleanup();
      stopSyncTimer();
      clearInterval(probeTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // options.* are stable callbacks from the caller (App wires the health
    // monitor's noteFailure once); re-subscribing the socket on every App
    // render would flap the connection, so the effect stays mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleEvent, resync, syncState]);

  return { views, setViews, setViewError, seedRevision, resyncPanels };
}
