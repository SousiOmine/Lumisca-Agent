import { useCallback, useEffect, useRef, useState } from "preact/compat";
import { api } from "../api.ts";
import { connectStellaEvents, stellaApi } from "../api-stella.ts";
import { errorText } from "../providers.ts";
import {
  applyStellaEvent,
  type StellaConversationState,
  stellaStateOf,
} from "../stella-state.ts";
import type { StellaAgent } from "../types.ts";

/** Reconnect backoff of the conversation's event stream: 2s → 4s → … 30s. */
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

/** Period between revision probes. While the stream is up the events are the
 * live source; the probe catches frames that were emitted but never arrived
 * (a socket that died without a close event) by re-reading the snapshot when
 * the conversation's counter moved. */
const REVISION_PROBE_MS = 30_000;

/**
 * stella mode's state: the agents, which one is being talked to, and that
 * agent's conversation.
 *
 * The conversation has its own endpoints and its own event stream (see
 * api-stella.ts), so this hook does not touch the tab views at all: a stella
 * conversation is not a session the App tracks (no tab, no session list, no
 * panels). What it keeps is the conversation's own state — the entries, the
 * streaming text, the run state and what is blocking it — advanced by the
 * pure reducer in stella-state.ts.
 *
 * The machine is not part of this hook's API because it is not part of the
 * user's: the server starts it when the conversation is requested, and the one
 * consequence the client shows is `starting` on the status it already polls.
 */
export function useStella(enabled: boolean): {
  agents: StellaAgent[];
  activeAgentId: string | null;
  select: (id: string) => void;
  /** The active agent's conversation, or null before it is open. */
  conversation: StellaConversationState | null;
  /** The conversation's session id (the key its published images are stored
   * under; the client addresses the conversation by agent). */
  sessionId: string | null;
  prompt: (text: string) => void;
  abort: () => void;
  answer: (
    toolCallId: string,
    answers: { id: string; values: string[] }[],
  ) => Promise<void>;
  rewind: (timestamp: number) => Promise<void>;
  finishHandover: (note: string, toolCallId: string) => Promise<void>;
  /** Why the conversation could not be opened, or null. */
  error: string | null;
  loading: boolean;
  /** Re-read the agent list (after a create / delete). */
  reloadAgents: () => void;
} {
  const [agents, setAgents] = useState<StellaAgent[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<
    StellaConversationState | null
  >(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [agentsVersion, setAgentsVersion] = useState(0);
  // Opening twice (a re-render, a retry) must not create two conversations.
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
      setConversation(null);
      return;
    }
    if (opening.current === activeAgentId) return;
    opening.current = activeAgentId;
    setLoading(true);
    setError(null);
    let disposed = false;
    void (async () => {
      try {
        const snapshot = await stellaApi.open(activeAgentId);
        if (disposed) return;
        // Seed from the snapshot: a page reload shows the conversation it
        // left, and the snapshot's `running` keeps a live run live.
        setConversation(stellaStateOf(snapshot));
        setSessionId(snapshot.sessionId);
      } catch (failure) {
        if (!disposed) setError(errorText(failure));
      } finally {
        if (opening.current === activeAgentId) opening.current = null;
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [enabled, activeAgentId]);

  // The conversation's event stream. One socket per open conversation; a
  // drop re-reads the snapshot (the events are never replayed) and
  // reconnects with backoff. Revision probes cover the frames that were
  // emitted while the socket looked open.
  useEffect(() => {
    if (!enabled || activeAgentId === null || conversation === null) return;
    let closed = false;
    let close: (() => void) | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const resync = async () => {
      try {
        const snapshot = await stellaApi.getSnapshot(activeAgentId);
        if (!closed) setConversation(stellaStateOf(snapshot));
      } catch {
        // The socket onClose path retries; a failed resync must not throw.
      }
    };

    const connect = () => {
      if (closed) return;
      close = connectStellaEvents(
        activeAgentId,
        (event) => {
          setConversation((current) => {
            if (current === null) return current;
            return applyStellaEvent(current, event) ?? current;
          });
        },
        () => {
          if (closed) return;
          void resync();
          retry = setTimeout(
            connect,
            Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS),
          );
          attempt += 1;
        },
        () => {
          attempt = 0;
          void resync();
        },
      );
    };

    connect();
    let probe = 0;
    const probeTimer = setInterval(() => {
      void (async () => {
        try {
          const { rev } = await stellaApi.getRevision(activeAgentId);
          if (closed) return;
          if (probe !== 0 && rev !== probe) await resync();
          probe = rev;
        } catch {
          // A failed probe is not an outage: the next one retries.
        }
      })();
    }, REVISION_PROBE_MS);

    return () => {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      clearInterval(probeTimer);
      close?.();
    };
    // `conversation === null` gates the first connection: there is no
    // stream before there is a conversation. Re-running on every state
    // change would reconnect per token, so only the agent and the "has an
    // open conversation" flag are dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, activeAgentId, conversation !== null]);

  // Switching agents drops the previous conversation's state (the
  // conversation itself stays on the server; coming back re-reads it).
  const select = useCallback((id: string) => {
    setActiveAgentId((current) => {
      if (current !== id) {
        setConversation(null);
        setSessionId(null);
      }
      return id === current ? current : id;
    });
  }, []);

  // Leaving stella mode drops the conversation's state.
  useEffect(() => {
    if (enabled) return;
    setConversation(null);
    setSessionId(null);
  }, [enabled]);

  /** The conversation's agent id, or throw: a client action without an open
   * conversation is a bug (the composer is disabled in that state). */
  const requireAgent = useCallback((): string => {
    if (activeAgentId === null) {
      throw new Error("No stella conversation is open");
    }
    return activeAgentId;
  }, [activeAgentId]);

  const prompt = useCallback(
    (text: string) => {
      const agentId = requireAgent();
      // Fire-and-forget: the run's progress arrives on the event stream, so
      // the composer is cleared immediately and a failure surfaces as the
      // conversation's error.
      void stellaApi.prompt(agentId, text).catch((failure: unknown) => {
        setError(errorText(failure));
      });
    },
    [requireAgent],
  );

  const abort = useCallback(() => {
    const agentId = requireAgent();
    void stellaApi.abort(agentId).catch((failure: unknown) => {
      setError(errorText(failure));
    });
  }, [requireAgent]);

  const answer = useCallback(
    async (
      toolCallId: string,
      answers: { id: string; values: string[] }[],
    ) => {
      await stellaApi.answer(requireAgent(), toolCallId, answers);
    },
    [requireAgent],
  );

  const rewind = useCallback(
    async (timestamp: number) => {
      await stellaApi.rewind(requireAgent(), timestamp);
    },
    [requireAgent],
  );

  const finishHandover = useCallback(
    async (note: string, toolCallId: string) => {
      await stellaApi.finishHandover(requireAgent(), note, toolCallId);
    },
    [requireAgent],
  );

  return {
    agents,
    activeAgentId,
    select,
    conversation,
    sessionId,
    prompt,
    abort,
    answer,
    rewind,
    finishHandover,
    error,
    loading,
    reloadAgents,
  };
}
