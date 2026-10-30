import { useCallback, useEffect, useRef, useState } from "preact/compat";
import { api, sessionApi } from "../api.ts";
import { errorText } from "../providers.ts";
import {
  emptyView,
  type SessionInfo,
  type SessionView,
  type StellaAgent,
} from "../types.ts";

/**
 * stella mode's state: the counterparts, which one is being talked to, and
 * that agent's conversation.
 *
 * The conversation is an ordinary session under the hood, so the WebSocket
 * events already carry its id and the App's view map already applies them —
 * this hook only learns the id, opens the view and keeps the agent list. That
 * reuse is why stella needs no second event pipeline: the transcript, live
 * tool state, questions and the panels all arrive the way they do for a tab.
 *
 * The machine is not part of this hook's API because it is not part of the
 * user's: the server starts it when the conversation is requested, and the one
 * consequence the client shows is `starting` on the status it already polls.
 */
export function useStella(
  enabled: boolean,
  setViews: (
    update: (prev: Map<string, SessionView>) => Map<string, SessionView>,
  ) => void,
): {
  agents: StellaAgent[];
  activeAgentId: string | null;
  select: (id: string) => void;
  /** The active agent's session id, or null until it is open. */
  sessionId: string | null;
  /** Its session info, or null until it is open. */
  info: SessionInfo | null;
  error: string | null;
  loading: boolean;
  /** Re-read the agent list (after a create / delete). */
  reloadAgents: () => void;
} {
  const [agents, setAgents] = useState<StellaAgent[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [agentsVersion, setAgentsVersion] = useState(0);
  // Opening twice (a re-render, a retry) must not create two conversations or
  // two view entries.
  const opening = useRef<string | null>(null);

  const reloadAgents = useCallback(() => {
    setAgentsVersion((version) => version + 1);
  }, []);

  // The agent list. Read when stella becomes the mode and after a change;
  // the last-used agent is the default, so reopening the app resumes the
  // conversation the user actually had.
  useEffect(() => {
    if (!enabled) {
      setAgents([]);
      setActiveAgentId(null);
      return;
    }
    let disposed = false;
    void (async () => {
      try {
        const { agents: list, defaultAgentId } = await api.getStellaAgents();
        if (disposed) return;
        setAgents(list);
        setActiveAgentId((current) => {
          if (current !== null && list.some((a) => a.id === current)) {
            return current;
          }
          return defaultAgentId ?? list[0]?.id ?? null;
        });
        setError(null);
      } catch (failure) {
        if (!disposed) setError(errorText(failure));
      }
    })();
    return () => {
      disposed = true;
    };
  }, [enabled, agentsVersion]);

  // Open the active agent's conversation. The server starts the machine on
  // this call, so a first run waits here (minutes) — `loading` is what the
  // view shows during it.
  useEffect(() => {
    if (!enabled || activeAgentId === null) {
      setSessionId(null);
      setInfo(null);
      return;
    }
    if (opening.current === activeAgentId) return;
    opening.current = activeAgentId;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const session = await api.getStellaSession(activeAgentId);
        // Seed the view from the transcript snapshot: a page reload must show
        // the conversation it left, and the snapshot carries the run state so
        // a run that is still going does not render as finished.
        const snapshot = await sessionApi(session.id).getMessages();
        // Keyed by the session id — the same key the event stream uses, so the
        // existing reducer feeds this view with no second pipeline.
        setViews((prev) => {
          const next = new Map(prev);
          const base = emptyView(session, snapshot.messages);
          next.set(session.id, {
            ...base,
            error: snapshot.error,
            pendingQuestions: snapshot.questions,
            pendingHandover: snapshot.handover,
            ...(snapshot.running ? { agentStartedAt: Date.now() } : {}),
          });
          return next;
        });
        setSessionId(session.id);
        setInfo(session);
      } catch (failure) {
        setError(errorText(failure));
      } finally {
        if (opening.current === activeAgentId) opening.current = null;
        setLoading(false);
      }
    })();
  }, [enabled, activeAgentId, setViews]);

  // Switching agents drops the previous conversation's view (the conversation
  // itself stays on the server; coming back re-reads it).
  const select = useCallback((id: string) => {
    setActiveAgentId((current) => {
      setSessionId((previous) => {
        if (previous === null) return null;
        setViews((prev) => {
          if (!prev.has(previous)) return prev;
          const next = new Map(prev);
          next.delete(previous);
          return next;
        });
        return null;
      });
      return id === current ? current : id;
    });
  }, [setViews]);

  // Leaving stella mode drops the view entirely.
  useEffect(() => {
    if (enabled) return;
    setSessionId((current) => {
      if (current !== null) {
        setViews((prev) => {
          if (!prev.has(current)) return prev;
          const next = new Map(prev);
          next.delete(current);
          return next;
        });
      }
      return null;
    });
    setInfo(null);
  }, [enabled, setViews]);

  return {
    agents,
    activeAgentId,
    select,
    sessionId,
    info,
    error,
    loading,
    reloadAgents,
  };
}
