import { useCallback, useEffect, useRef, useState } from "react";
import { connectEvents, sessionApi } from "../api.ts";
import { errorText } from "../providers.ts";
import { applyEvent, filterRemoved, mergeMessages } from "../events.ts";
import { tabKey } from "../tabs.ts";
import type { AgentMessage, ClientEvent, SessionView } from "../types.ts";

/** Period between opportunistic message re-syncs (see syncMessages). */
const SYNC_INTERVAL_MS = 20_000;

/** Session views plus the WebSocket event stream that feeds them:
 * reconnect with resync on drop, periodic message sync, and per-view error
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

  /** Re-fetch persisted messages for every open tab and merge them in
   * without duplicating what is already shown. Runs on reconnect and on an
   * interval so a run that completes while the socket was down is not lost
   * until the next WS drop. */
  const syncMessages = useCallback(async () => {
    const ids = [...viewsRef.current.keys()];
    const fetched = new Map<string, AgentMessage[]>();
    await Promise.all(ids.map(async (id) => {
      try {
        fetched.set(id, await sessionApi(id).getMessages());
      } catch {
        // Server not reachable yet; keep the current list.
      }
    }));
    if (fetched.size === 0) return;
    setViews((prev) => {
      const next = new Map(prev);
      for (const [id, messages] of fetched) {
        const v = next.get(id);
        if (!v) continue;
        // Rewind tombstones: messages deleted while the socket was down
        // must not come back through the append-only merge.
        const merged = filterRemoved(
          mergeMessages(v.messages, messages),
          v.removed,
        );
        if (merged.length === v.messages.length) continue;
        next.set(id, { ...v, messages: merged });
      }
      return next;
    });
  }, []);

  /** Clear per-session transient state (stuck streaming/tool indicators)
   * and re-fetch persisted messages, so nothing is lost after a WS drop. */
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
    await syncMessages();
  }, [syncMessages]);

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
    // window would otherwise only appear at the next WS drop.
    const syncTimer = setInterval(() => {
      syncMessages();
    }, SYNC_INTERVAL_MS);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      clearInterval(syncTimer);
      disconnect?.();
    };
  }, [handleEvent, resync, syncMessages]);

  return { views, setViews, setViewError };
}
