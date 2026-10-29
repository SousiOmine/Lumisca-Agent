import { useCallback, useEffect, useRef, useState } from "preact/compat";
import { api, sessionApi } from "../api.ts";
import { errorText } from "../providers.ts";
import { emptyView, type SessionInfo, type SessionView } from "../types.ts";

/**
 * stella mode's single conversation, as a view the App's existing event
 * stream can feed.
 *
 * The conversation is an ordinary session under the hood (one hidden row), so
 * the WebSocket events already carry its id and the App's view map already
 * applies them — this hook only exists to learn the id and to open the view.
 * Reusing that machinery is why stella needs no second event pipeline: the
 * transcript, live tool state, questions and the panels all arrive the same
 * way they do for a tab.
 *
 * The machine must be up before the conversation is opened: the server
 * refuses to build a stella agent without it (its tools would have nowhere to
 * run), and a first-run image build happens here.
 */
export function useStellaSession(
  enabled: boolean,
  setViews: (
    update: (prev: Map<string, SessionView>) => Map<string, SessionView>,
  ) => void,
): {
  /** The conversation's session id, or null until it is open. */
  sessionId: string | null;
  /** The conversation's session info, or null until it is open. The stella
   * view needs it to render its composer before the transcript arrives. */
  info: SessionInfo | null;
  /** Create/open the conversation (after the machine is running). */
  open: () => void;
  error: string | null;
  loading: boolean;
} {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Opening twice (a re-render, a retry after the machine started) must not
  // create two conversations or two view entries.
  const opening = useRef(false);

  const open = useCallback(() => {
    if (opening.current) return;
    opening.current = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const session = await api.getStellaSession();
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
            ...(snapshot.running ? { agentStartedAt: Date.now() } : {}),
          });
          return next;
        });
        setSessionId(session.id);
        setInfo(session);
      } catch (failure) {
        setError(errorText(failure));
      } finally {
        opening.current = false;
        setLoading(false);
      }
    })();
  }, [setViews]);

  // Leaving stella mode drops the view (the conversation itself stays on the
  // server; coming back re-reads it).
  useEffect(() => {
    if (enabled) return;
    setInfo(null);
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
  }, [enabled, setViews]);

  return { sessionId, info, open, error, loading };
}
