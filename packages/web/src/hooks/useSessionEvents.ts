import { useCallback, useEffect, useRef, useState } from "preact/compat";
import { connectEvents, sessionApi } from "../api.ts";
import { errorText } from "../providers.ts";
import {
  applyEvent,
  filterRemoved,
  mergeBackgrounds,
  mergeMessages,
  mergeTasks,
  sameBackgrounds,
  sameGoal,
  sameTasks,
  sameTodoPlan,
} from "../events.ts";
import { tabKey } from "../tabs.ts";
import { maybeNotifyAgentEnd, maybeNotifyQuestion } from "../notify.ts";
import type {
  AgentMessage,
  BackgroundCommandInfo,
  ClientEvent,
  GoalInfo,
  SessionView,
  TaskInfo,
  TodoPhase,
} from "../types.ts";

/** Period between opportunistic state re-syncs while the WebSocket is
 * disconnected (see syncState). While the socket is up the events are the
 * live source; a tab returning to the foreground is the only other moment
 * a re-sync runs. */
const DISCONNECTED_SYNC_INTERVAL_MS = 10_000;

/** Event-stream reconnect backoff: 2s → 4s → 8s … capped at 30s. */
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

/** Session views plus the WebSocket event stream that feeds them:
 * reconnect with resync on drop, state sync while disconnected and on
 * tab-return, and per-view error recording. The returned setViews is
 * shared with the tab and session action logic. `onConnectionLost` fires
 * on every WS close (the desktop health monitor uses it to arm its
 * server-down banner); `onConnectionOpen` fires on every (re)connect. */
export function useSessionEvents(
  options: {
    onConnectionLost?: () => void;
    onConnectionOpen?: () => void;
  } = {},
) {
  const [views, setViews] = useState<Map<string, SessionView>>(new Map());
  const viewsRef = useRef(views);
  // Ref writes happen in an effect: writing during render breaks under
  // concurrent rendering. The WS event handler reads the ref, so it always
  // sees the latest views.
  useEffect(() => {
    viewsRef.current = views;
  }, [views]);

  /** Re-fetch persisted messages, the todo plan, the task snapshots, and
   * the background-command snapshots for every open tab and merge them in
   * without duplicating what is already shown. Runs on reconnect, on a
   * short interval while the socket is down, and when a connected tab
   * returns to the foreground, so a run that completes while the socket
   * was down — and todo/task/background mutations whose snapshot events
   * were lost — are not missed until the next WS drop. The todo plan is a
   * snapshot fetch (the events only fire on mutations), so the fetched
   * state replaces the view's plan wholesale; tasks merge per agent id so
   * live deltas are preserved. */
  const syncState = useCallback(async () => {
    const ids = [...viewsRef.current.keys()];
    const messages = new Map<string, AgentMessage[]>();
    const todos = new Map<string, TodoPhase[]>();
    const tasks = new Map<string, TaskInfo[]>();
    const backgrounds = new Map<string, BackgroundCommandInfo[]>();
    const goals = new Map<string, GoalInfo | null>();
    await Promise.all(ids.map(async (id) => {
      // Fetch independently: one failing (e.g. the session was deleted)
      // must not drop the other.
      try {
        messages.set(id, await sessionApi(id).getMessages());
      } catch {
        // Server not reachable yet; keep the current list.
      }
      try {
        const { todos: plan } = await sessionApi(id).getTodo();
        todos.set(id, plan);
      } catch {
        // Server not reachable yet; keep the current plan.
      }
      try {
        const { tasks: snapshot } = await sessionApi(id).getTasks();
        tasks.set(id, snapshot);
      } catch {
        // Server not reachable yet; keep the current tasks.
      }
      try {
        const { backgrounds: snapshot } = await sessionApi(id).getBackground();
        backgrounds.set(id, snapshot);
      } catch {
        // Server not reachable yet; keep the current backgrounds.
      }
      try {
        const { goal } = await sessionApi(id).getGoal();
        goals.set(id, goal);
      } catch {
        // Server not reachable yet; keep the current goal.
      }
    }));
    if (
      messages.size === 0 && todos.size === 0 && tasks.size === 0 &&
      backgrounds.size === 0 && goals.size === 0
    ) {
      return;
    }
    setViews((prev) => {
      const next = new Map(prev);
      for (
        const id of new Set([
          ...messages.keys(),
          ...todos.keys(),
          ...tasks.keys(),
          ...backgrounds.keys(),
          ...goals.keys(),
        ])
      ) {
        const v = next.get(id);
        if (!v) continue;
        const fetched = messages.get(id);
        // Rewind tombstones: messages deleted while the socket was down
        // must not come back through the append-only merge.
        const merged = fetched === undefined
          ? v.messages
          : filterRemoved(mergeMessages(v.messages, fetched), v.removed);
        const todo = todos.get(id);
        const todoChanged = todo !== undefined &&
          !sameTodoPlan(todo, v.todos);
        const fetchedTasks = tasks.get(id);
        const mergedTasks = fetchedTasks === undefined
          ? v.tasks
          : mergeTasks(v.tasks, fetchedTasks);
        const tasksChanged = fetchedTasks !== undefined &&
          !sameTasks(mergedTasks, v.tasks);
        const fetchedBackgrounds = backgrounds.get(id);
        const mergedBackgrounds = fetchedBackgrounds === undefined
          ? v.backgrounds
          : mergeBackgrounds(v.backgrounds, fetchedBackgrounds);
        const backgroundsChanged = fetchedBackgrounds !== undefined &&
          !sameBackgrounds(mergedBackgrounds, v.backgrounds);
        const fetchedGoal = goals.get(id);
        const goalChanged = fetchedGoal !== undefined &&
          !sameGoal(fetchedGoal ?? undefined, v.goal);
        if (
          merged.length === v.messages.length && !todoChanged &&
          !tasksChanged &&
          !backgroundsChanged && !goalChanged
        ) {
          continue;
        }
        next.set(id, {
          ...v,
          messages: merged,
          ...(todoChanged ? { todos: todo } : {}),
          ...(tasksChanged ? { tasks: mergedTasks } : {}),
          ...(backgroundsChanged ? { backgrounds: mergedBackgrounds } : {}),
          ...(goalChanged ? { goal: fetchedGoal ?? undefined } : {}),
        });
      }
      return next;
    });
  }, []);

  /** Clear per-session transient state (stuck streaming/tool indicators)
   * and re-fetch persisted messages and the todo plan, so nothing is lost
   * after a WS drop. */
  const resync = useCallback(async () => {
    setViews((prev) => {
      const next = new Map(prev);
      for (const [id, v] of next) {
        next.set(id, {
          ...v,
          streamingText: "",
          runningTools: new Map(),
          pendingQuestions: [],
          error: undefined,
          agentStartedAt: undefined,
          agentEndedAt: undefined,
          thinkingStartAt: undefined,
        });
      }
      return next;
    });
    await syncState();
  }, [syncState]);

  /** Apply a WS event to the matching session view (pure reducer). Events
   * carry the peer id ("" = this server); the tab key resolves the view.
   *
   * `agent_end` and `question` events additionally arm an OS notification
   * when the app is hidden (the notify module decides): the reducer below
   * must stay the single writer of view state, so notification sends are
   * fire-and-forget and never block or reorder the state update. */
  const handleEvent = useCallback(
    (event: ClientEvent & { peerId?: string }) => {
      if (event.type === "session_created") return;
      const key = tabKey(event.peerId ?? "", event.sessionId);
      if (event.type === "agent_end" || event.type === "question") {
        const view = viewsRef.current.get(key);
        const name = view?.info.name ?? event.sessionId;
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
    [],
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
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // options.* are stable callbacks from the caller (App wires the health
    // monitor's noteFailure once); re-subscribing the socket on every App
    // render would flap the connection, so the effect stays mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleEvent, resync, syncState]);

  return { views, setViews, setViewError };
}
