import { useCallback, useEffect, useRef, useState } from "react";
import { connectEvents, sessionApi } from "../api.ts";
import { errorText } from "../providers.ts";
import {
  applyEvent,
  filterRemoved,
  mergeMessages,
  mergeTasks,
  sameTasks,
  sameTodoPlan,
} from "../events.ts";
import { tabKey } from "../tabs.ts";
import type {
  AgentMessage,
  ClientEvent,
  SessionView,
  TaskInfo,
  TodoPhase,
} from "../types.ts";

/** Period between opportunistic state re-syncs while the WebSocket is
 * disconnected (see syncState). While the socket is up the events are the
 * live source; a tab returning to the foreground is the only other moment
 * a re-sync runs. */
const DISCONNECTED_SYNC_INTERVAL_MS = 10_000;

/** Session views plus the WebSocket event stream that feeds them:
 * reconnect with resync on drop, state sync while disconnected and on
 * tab-return, and per-view error recording. The returned setViews is
 * shared with the tab and session action logic. */
export function useSessionEvents() {
  const [views, setViews] = useState<Map<string, SessionView>>(new Map());
  const viewsRef = useRef(views);
  // Ref writes happen in an effect: writing during render breaks under
  // concurrent rendering. The WS event handler reads the ref, so it always
  // sees the latest views.
  useEffect(() => {
    viewsRef.current = views;
  }, [views]);

  /** Re-fetch persisted messages, the todo plan, and the task snapshots for
   * every open tab and merge them in without duplicating what is already
   * shown. Runs on reconnect, on a short interval while the socket is
   * down, and when a connected tab returns to the foreground, so a run
   * that completes while the socket was down — and todo/task mutations
   * whose snapshot events were lost — are not missed until the next WS
   * drop. The todo plan is a snapshot fetch (the events only fire on
   * mutations), so the fetched state replaces the view's plan wholesale;
   * tasks merge per agent id so live deltas are preserved. */
  const syncState = useCallback(async () => {
    const ids = [...viewsRef.current.keys()];
    const messages = new Map<string, AgentMessage[]>();
    const todos = new Map<string, TodoPhase[]>();
    const tasks = new Map<string, TaskInfo[]>();
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
    }));
    if (messages.size === 0 && todos.size === 0 && tasks.size === 0) return;
    setViews((prev) => {
      const next = new Map(prev);
      for (
        const id of new Set([
          ...messages.keys(),
          ...todos.keys(),
          ...tasks.keys(),
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
        if (
          merged.length === v.messages.length && !todoChanged && !tasksChanged
        ) {
          continue;
        }
        next.set(id, {
          ...v,
          messages: merged,
          ...(todoChanged ? { todos: todo } : {}),
          ...(tasksChanged ? { tasks: mergedTasks } : {}),
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
   * carry the peer id ("" = this server); the tab key resolves the view. */
  const handleEvent = useCallback(
    (event: ClientEvent & { peerId?: string }) => {
      if (event.type === "session_created") return;
      const key = tabKey(event.peerId ?? "", event.sessionId);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let syncTimer: ReturnType<typeof setInterval> | undefined;
    let disconnect: (() => void) | undefined;
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

    // Opportunistic sync: a run that finishes entirely inside a disconnect
    // window — or a todo mutation whose snapshot event was lost — would
    // otherwise only appear at the next reconnect. While connected the WS
    // delivers the events, so a tab returning to the foreground is the
    // only moment a missed state gets re-synced (the interval covers the
    // disconnected case).
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (connected) syncState();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const connect = () => {
      disconnect = connectEvents(
        handleEvent,
        () => {
          // On close: clear stuck state and re-sync, then reconnect.
          if (disposed) return;
          connected = false;
          startSyncTimer();
          resync();
          timer = setTimeout(connect, 1500);
        },
        () => {
          // On (re)open: re-sync state (events emitted while the socket
          // was down are merged in) and stop the fallback interval — the
          // stream is the live source again.
          connected = true;
          stopSyncTimer();
          resync();
        },
      );
    };
    connect();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      stopSyncTimer();
      document.removeEventListener("visibilitychange", onVisibility);
      disconnect?.();
    };
  }, [handleEvent, resync, syncState]);

  return { views, setViews, setViewError };
}
