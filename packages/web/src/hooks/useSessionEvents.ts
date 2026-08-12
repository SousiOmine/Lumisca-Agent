import { useCallback, useEffect, useRef, useState } from "react";
import { connectEvents, sessionApi } from "../api.ts";
import { errorText } from "../providers.ts";
import {
  applyEvent,
  filterRemoved,
  mergeMessages,
  sameTodoPlan,
} from "../events.ts";
import { tabKey } from "../tabs.ts";
import type {
  AgentMessage,
  ClientEvent,
  SessionView,
  TodoPhase,
} from "../types.ts";

/** Period between opportunistic state re-syncs (see syncState). */
const SYNC_INTERVAL_MS = 20_000;

/** Session views plus the WebSocket event stream that feeds them:
 * reconnect with resync on drop, periodic state sync, and per-view error
 * recording. The returned setViews is shared with the tab and session
 * action logic. */
export function useSessionEvents() {
  const [views, setViews] = useState<Map<string, SessionView>>(new Map());
  const viewsRef = useRef(views);
  // Ref writes happen in an effect: writing during render breaks under
  // concurrent rendering. The WS event handler reads the ref, so it always
  // sees the latest views.
  useEffect(() => {
    viewsRef.current = views;
  }, [views]);

  /** Re-fetch persisted messages and the todo plan for every open tab and
   * merge them in without duplicating what is already shown. Runs on
   * reconnect and on an interval so a run that completes while the socket
   * was down — and todo mutations whose snapshot events were lost — are
   * not missed until the next WS drop. The todo plan is a snapshot fetch
   * (the events only fire on mutations), so the fetched state replaces
   * the view's plan wholesale. */
  const syncState = useCallback(async () => {
    const ids = [...viewsRef.current.keys()];
    const messages = new Map<string, AgentMessage[]>();
    const todos = new Map<string, TodoPhase[]>();
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
    }));
    if (messages.size === 0 && todos.size === 0) return;
    setViews((prev) => {
      const next = new Map(prev);
      for (const id of new Set([...messages.keys(), ...todos.keys()])) {
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
        if (merged.length === v.messages.length && !todoChanged) continue;
        next.set(id, {
          ...v,
          messages: merged,
          ...(todoChanged ? { todos: todo } : {}),
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
    let disconnect: (() => void) | undefined;

    const connect = () => {
      disconnect = connectEvents(
        handleEvent,
        () => {
          // On close: clear stuck state and re-sync, then reconnect.
          if (disposed) return;
          resync();
          timer = setTimeout(connect, 1500);
        },
        resync,
      );
    };
    connect();

    // Opportunistic sync: a run that finishes entirely inside a disconnect
    // window — or a todo mutation whose snapshot event was lost — would
    // otherwise only appear at the next WS drop.
    const syncTimer = setInterval(() => {
      syncState();
    }, SYNC_INTERVAL_MS);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      clearInterval(syncTimer);
      disconnect?.();
    };
  }, [handleEvent, resync, syncState]);

  return { views, setViews, setViewError };
}
