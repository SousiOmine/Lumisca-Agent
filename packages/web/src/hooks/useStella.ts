import {
  mergeAgentRows,
  newestPreview,
  withAgentPreview,
  withAgentRow,
} from "@lumisca/core/shared";
import { useCallback, useEffect, useRef, useState } from "preact/compat";
import { api } from "../api.ts";
import { connectStellaEvents, stellaApi } from "../api-stella.ts";
import { describeError, useT } from "../i18n.ts";
import {
  maybeNotifyAgentEnd,
  maybeNotifyEnv,
  maybeNotifyHandover,
} from "../notify.ts";
import {
  applyStellaEvent,
  prependOlderEntries,
  type StellaConversationState,
  stellaStateOf,
} from "../stella-state.ts";
import type {
  PendingFile,
  PendingImage,
  StellaAgent,
  StellaAgentSummary,
  StellaEvent,
} from "../types.ts";
import { startRevisionProbe } from "./useRevisionProbe.ts";
import { createStreamController } from "./useStreamController.ts";
import { NEVER, useVisibleInterval } from "./useVisibleInterval.ts";

/** How often the agent list is re-read while the page is visible.
 *
 * The list says what each conversation last said, and only the conversation
 * being looked at has an open stream: a routine that posts overnight, or a
 * second window showing the same server, writes into conversations whose rows
 * this client never hears about. Re-reading the list is the only way those
 * rows change. Nothing runs while the page is hidden (see useVisibleInterval)
 * — nobody is reading it. */
const AGENT_LIST_REFRESH_MS = 30_000;

/**
 * stella mode's state: the agents, which one the address names, and that
 * agent's conversation.
 *
 * The conversation has its own endpoints and its own event stream (see
 * api-stella.ts), so this hook does not touch the tab views at all: a stella
 * conversation is not a session the App tracks (no tab, no session list, no
 * panels). What it keeps is the conversation's own state — the entries, the
 * streaming text, the run state and what is blocking it — advanced by the
 * pure reducer in stella-state.ts.
 *
 * WHICH conversation is open is not this hook's to decide: the address names
 * the agent (`/stella/a/<id>`), and choosing another is a navigation the App
 * makes. The hook reads the conversation the address names and drops it when
 * the address moves on.
 *
 * The machine is not part of this hook's API because it is not part of the
 * user's: the server starts it when the conversation is requested, and the one
 * consequence the client shows is `starting` on the status it already polls.
 */
export type StellaHook = {
  /** The sidebar's rows, newest message first (see compareAgentRows). */
  agents: StellaAgentSummary[];
  /** The first read of the agent list is in flight. The list is empty until
   * it lands, so without this the sidebar says "no agent yet" over a list
   * that is on its way — a line the reader reads and believes. */
  agentsLoading: boolean;
  /** The agent whose conversation the address names, or null on the list.
   * An input (the URL is where the choice lives), not something this hook
   * decides: switching agents is a navigation. */
  activeAgentId: string | null;
  /** The active agent's conversation, or null before it is open. */
  conversation: StellaConversationState | null;
  /** The conversation's session id (the key its published images are stored
   * under; the client addresses the conversation by agent). */
  sessionId: string | null;
  /** Send the composer's text with the attachments: `images` are shown
   * inline and passed to the model as content, `files` are written into the
   * machine and named in the text the model receives. */
  /** Send the prompt. Rejects when the server did not take it (the
   * conversation error is set as well); the composer restores the text. */
  prompt: (
    text: string,
    images?: PendingImage[],
    files?: PendingFile[],
  ) => Promise<void>;
  abort: () => void;
  answer: (
    toolCallId: string,
    answers: { id: string; values: string[] }[],
  ) => Promise<void>;
  rewind: (timestamp: number) => Promise<void>;
  finishHandover: (note: string, toolCallId: string) => Promise<void>;
  /** Enter the value of the environment variable the run waits for
   * (`vm_env`). Rejects when the server did not take it (an expired
   * dialog); the dialog shows the failure and stays open. */
  provideEnv: (value: string, toolCallId: string) => Promise<void>;
  /** Refuse to enter a value: the run continues without it. */
  declineEnv: (toolCallId: string) => Promise<void>;
  /** Read the entries before the loaded window (the reader reached the top
   * of the conversation). Returns whether a read started. */
  loadOlder: () => boolean;
  /** Whether that read is still in flight. */
  loadingOlder: boolean;
  /** Why the conversation could not be opened, or null. A failed prompt or
   * abort is NOT this: that failure leaves the conversation open and is shown
   * in the transcript (see prompt / abort), because replacing a whole
   * conversation with an error because one send failed loses the history the
   * user would retry from. */
  error: string | null;
  loading: boolean;
  /** Re-read the agent list (after a create / delete). */
  reloadAgents: () => void;
  /** Put one agent's row into the list as the server answered it — an edit
   * (a new name, picture or model) or a create — so the sidebar and the
   * header redraw without a full re-read of the list. A row the list does not
   * hold yet is added: the address names a new conversation before any
   * re-read could land, and the App treats an address naming an agent it
   * cannot find as a conversation that is gone (see withAgentRow). */
  applyAgent: (agent: StellaAgent) => void;
};

export function useStella(
  enabled: boolean,
  activeAgentId: string | null,
): StellaHook {
  // Failure text is written in the language the app is in when it happens
  // (the hook holds strings, not failure objects).
  const t = useT();
  const [agents, setAgents] = useState<StellaAgentSummary[]>([]);
  /** Whether the first read of the list has settled (a failure counts: the
   * list is then known to be empty). `agentsLoading` is derived from it, so
   * the very first paint already says "reading" instead of flashing the
   * empty state for a frame. */
  const [agentsSettled, setAgentsSettled] = useState(false);
  const [conversation, setConversation] =
    useState<StellaConversationState | null>(null);
  /** The agent `conversation` belongs to.
   *
   * Kept beside it rather than read from `activeAgentId`, because the two are
   * not the same value for the frame in which the address has moved on: the
   * state is dropped by an effect, so one render still holds the previous
   * conversation under the new address. Anything that applies the
   * conversation to something else — its row's preview — must check whose it
   * is first, or it speaks for a conversation that has not been opened. */
  const [conversationAgentId, setConversationAgentId] = useState<string | null>(
    null,
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [agentsVersion, setAgentsVersion] = useState(0);
  /** An older window is in flight; a second reach for the top waits for it
   * rather than reading the same page twice. The state is what the transcript
   * reads to keep the reader's position until the page lands. */
  const olderInFlight = useRef(false);
  /** The newest conversation, for the event stream: a notification names the
   * agent, and the callback that runs must not read a stale render. */
  const conversationRef = useRef<StellaConversationState | null>(null);
  useEffect(() => {
    conversationRef.current = conversation;
  }, [conversation]);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const reloadAgents = useCallback(() => {
    setAgentsVersion((version) => version + 1);
  }, []);

  /** Take the row the server answered. An edit keeps the row's own preview
   * and place; a create adds a row that has said nothing yet. In both cases
   * the list is the answer's, not a re-read's — see withAgentRow. */
  const applyAgent = useCallback((agent: StellaAgent) => {
    setAgents((current) => withAgentRow(current, agent));
  }, []);

  // The agent list: read when stella becomes the mode, after a change, and on
  // the refresh timer below. Nothing here picks a conversation — the address
  // does (see the module comment), so a list that arrives decides only what
  // the sidebar draws.
  useEffect(() => {
    if (!enabled) {
      setAgents([]);
      setAgentsSettled(false);
      return;
    }
    let disposed = false;
    void (async () => {
      try {
        const { agents: list } = await api.getStellaAgents();
        if (disposed) return;
        // Folded into what the list holds rather than replacing it: a read
        // that was in flight when a message landed would otherwise put that
        // row back (see mergeAgentRows).
        setAgents((current) => mergeAgentRows(current, list));
        setError(null);
      } catch (failure) {
        if (!disposed) setError(describeError(failure, t));
      } finally {
        // Settled either way: a failed read leaves an empty list, and the
        // empty state is then the truth.
        if (!disposed) setAgentsSettled(true);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [enabled, agentsVersion, t]);

  // The list's second line goes stale on its own: another window, or a
  // routine, writes into conversations this client has no stream for. A
  // re-read is the only thing that moves those rows, and it is cheap (a
  // bounded read per agent, see stella/previews.ts).
  useVisibleInterval(reloadAgents, enabled ? AGENT_LIST_REFRESH_MS : NEVER, {
    immediate: false,
  });

  // The row of the conversation that is open, advanced from its own entries:
  // the list re-reads every 30 seconds, but the message the user just
  // received is on screen now, and a row that lags behind the conversation
  // beside it is the kind of disagreement this line exists to avoid. The
  // preview is built by the same function the server used, so the two can
  // only say the same thing.
  //
  // Written into the row, not derived from the selection. A list computed as
  // "the rows, with the selected conversation's newest message folded in"
  // changes when the selection does: the message the previously selected row
  // had been showing is taken back out, and two recent conversations swap
  // places every time the reader looks at the other one. A row may move when
  // something is SAID — that is the list's order — and not when a row is
  // opened.
  useEffect(() => {
    if (!enabled || conversation === null || conversationAgentId === null) {
      return;
    }
    // The frame in which the address has moved on but the effect that drops
    // the state has not run yet still holds the previous conversation. Its
    // messages are not this agent's last words.
    if (conversationAgentId !== activeAgentId) return;
    const preview = newestPreview(conversation.entries);
    if (preview === null) return;
    setAgents((current) =>
      withAgentPreview(current, conversationAgentId, preview),
    );
  }, [enabled, activeAgentId, conversationAgentId, conversation]);

  // Open the active agent's conversation. The server starts the machine on
  // this call, so a first run waits here (minutes) — `loading` is what the
  // view shows during it.
  //
  // No "already opening" guard: the effect's dependencies are the agent and
  // the mode, so it runs once per selection, and the server's open is
  // idempotent (one conversation per agent, and the machine's start is
  // memoized). A guard keyed by agent id used to hold the id of an open whose
  // effect had already been cleaned up — leaving a conversation disposed
  // mid-flight — and the next selection of that same agent returned early
  // against it: nothing was read, `loading` never cleared, and the screen
  // waited forever.
  useEffect(() => {
    if (!enabled || activeAgentId === null) {
      setConversation(null);
      setConversationAgentId(null);
      return;
    }
    setLoading(true);
    setError(null);
    let disposed = false;
    void (async () => {
      try {
        const snapshot = await stellaApi.open(activeAgentId);
        if (disposed) return;
        // Seed from the snapshot: a page reload shows the conversation it
        // left, and the snapshot's `running` keeps a live run live. The
        // agent id is recorded in the same commit as the state, so a reader
        // of `conversation` can always tell whose it is.
        setConversationAgentId(activeAgentId);
        setConversation(stellaStateOf(snapshot));
        setSessionId(snapshot.sessionId);
      } catch (failure) {
        if (!disposed) setError(describeError(failure, t));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [enabled, activeAgentId, t]);

  // The conversation's event stream. One socket per open conversation; a
  // drop re-reads the snapshot (the events are never replayed) and
  // reconnects with backoff. Revision probes cover the frames that were
  // emitted while the socket looked open.
  useEffect(() => {
    if (!enabled || activeAgentId === null || conversation === null) return;
    let closed = false;
    /** Whether a run was under way when the last event arrived. A duplicate
     * `agent_end` (the same run's end seen twice) must not notify twice, and
     * a resynced snapshot is the truth about it. */
    let wasRunning = false;
    /** The last thing the agent said in this run: the notification's body,
     * because "finished" alone does not say whether it is worth opening. */
    let lastReply = "";
    /** The hand-over already announced: a duplicate `handover` event (the
     * same request seen twice) must not notify twice. Tool call ids are
     * unique, so the id alone tells "the same request" from a new one. */
    let notifiedHandover: string | null = null;
    /** The `vm_env` dialog already announced, for the same reason. */
    let notifiedEnv: string | null = null;

    const resync = async () => {
      try {
        const snapshot = await stellaApi.getSnapshot(activeAgentId);
        // Merged, not replaced: the client may hold windows the reader paged
        // back to, and the snapshot is only the newest one (see stellaStateOf).
        if (!closed) {
          wasRunning = snapshot.running;
          setConversation((current) =>
            stellaStateOf(snapshot, current ?? undefined),
          );
        }
      } catch {
        // The socket onClose path retries; a failed resync must not throw.
      }
    };

    const stream = createStreamController<StellaEvent>({
      stopped: () => closed,
      connect: ({ onEvent, onClose, onOpen }) =>
        connectStellaEvents(activeAgentId, onEvent, onClose, onOpen),
      onEvent: (event) => {
        // Every event of a conversation is a whole message or a change of
        // what the run is waiting on: there is no streamed text to buffer,
        // so each one is applied as it arrives.
        // A run's end is the moment a user who is looking elsewhere needs
        // to hear about it. Code mode does this in its own event handler;
        // stella's stream is a different one, so a routine's result was
        // silent here (#41). A hand-over is the same need from the other
        // side: the run is blocked AT THE SCREEN, and only the user can
        // release it.
        if (event.type === "agent_start") wasRunning = true;
        if (event.type === "entry" && event.entry.role === "assistant") {
          lastReply = event.entry.text;
        }
        if (
          event.type === "handover" &&
          event.handover !== null &&
          event.handover.toolCallId !== notifiedHandover
        ) {
          notifiedHandover = event.handover.toolCallId;
          void maybeNotifyHandover(
            conversationRef.current?.agentName ?? "",
            event.handover.reason,
          );
        }
        if (
          event.type === "env_request" &&
          event.request !== null &&
          event.request.toolCallId !== notifiedEnv
        ) {
          notifiedEnv = event.request.toolCallId;
          void maybeNotifyEnv(
            conversationRef.current?.agentName ?? "",
            event.request.name,
          );
        }
        if (event.type === "agent_end") {
          if (wasRunning) {
            wasRunning = false;
            // A silent routine's run is removed from the conversation, so
            // there is nothing to open the app for.
            if (event.silent !== true) {
              void maybeNotifyAgentEnd(
                conversationRef.current?.agentName ?? "",
                lastReply,
              );
            }
          }
          lastReply = "";
        }
        setConversation((current) => {
          if (current === null) return current;
          return applyStellaEvent(current, event) ?? current;
        });
      },
      onClose: () => {
        void resync();
      },
      onOpen: () => {
        void resync();
      },
    });
    stream.connect();
    // The conversation has a revision counter of its own; a probe compares it
    // with what this view has seen (see useRevisionProbe).
    let probe: number | undefined;
    const stopProbe = startRevisionProbe({
      knownRevision: () => probe,
      remember: (_key, revision) => {
        probe = revision;
      },
      readRevision: async () =>
        (await stellaApi.getRevision(activeAgentId)).rev,
      onMoved: () => void resync(),
      keys: () => [activeAgentId],
      enabled: () => true,
      disposed: () => closed,
    });

    return () => {
      closed = true;
      stream.close();
      stopProbe();
    };
    // `conversation === null` gates the first connection: there is no
    // stream before there is a conversation. Re-running on every state
    // change would reconnect per message, so only the agent and the "has an
    // open conversation" flag are dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, activeAgentId, conversation !== null]);

  // The address moved to another conversation (or back to the list): drop
  // the previous one's state. The conversation itself stays on the server, so
  // returning to it re-reads it — which is also what keeps a stale transcript
  // from appearing under another agent's name.
  useEffect(() => {
    setConversation(null);
    setConversationAgentId(null);
    setSessionId(null);
  }, [activeAgentId]);

  // Leaving stella mode drops the conversation's state.
  useEffect(() => {
    if (enabled) return;
    setConversation(null);
    setConversationAgentId(null);
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
    async (
      text: string,
      images?: PendingImage[],
      files?: PendingFile[],
    ): Promise<void> => {
      const agentId = requireAgent();
      // The failure is the CONVERSATION's, not the hook's: a send that
      // failed leaves the conversation open, and replacing the whole
      // transcript with an error screen (which is what `error` does) would
      // throw away the history the user retries from. It is rethrown as
      // well, so the composer can put the text back (see ChatView.submit).
      try {
        await stellaApi.prompt(agentId, text, images, files);
      } catch (failure) {
        setConversation((current) =>
          current === null
            ? current
            : {
                ...current,
                error: describeError(failure, t),
              },
        );
        throw failure;
      }
    },
    [requireAgent, t],
  );

  const abort = useCallback(() => {
    const agentId = requireAgent();
    // Same rule as prompt: a refused abort is a fact about this run, said in
    // the transcript beside it, not a reason to hide the conversation.
    void stellaApi.abort(agentId).catch((failure: unknown) => {
      setConversation((current) =>
        current === null
          ? current
          : {
              ...current,
              error: describeError(failure, t),
            },
      );
    });
  }, [requireAgent, t]);

  const answer = useCallback(
    async (toolCallId: string, answers: { id: string; values: string[] }[]) => {
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

  const provideEnv = useCallback(
    async (value: string, toolCallId: string) => {
      await stellaApi.provideEnv(requireAgent(), value, toolCallId);
    },
    [requireAgent],
  );

  const declineEnv = useCallback(
    async (toolCallId: string) => {
      await stellaApi.declineEnv(requireAgent(), toolCallId);
    },
    [requireAgent],
  );

  /** Read the entries before the loaded window (the reader reached the top
   * of the conversation). Returns whether a read started. */
  const loadOlder = useCallback((): boolean => {
    const agentId = activeAgentId;
    const older = conversation?.older ?? null;
    if (agentId === null || older === null || olderInFlight.current) {
      return false;
    }
    olderInFlight.current = true;
    setLoadingOlder(true);
    void (async () => {
      try {
        const snapshot = await stellaApi.getSnapshot(agentId, { older });
        setConversation((current) => {
          // A resync may have replaced the history while the page was in
          // flight: placing it would splice two conversations together.
          if (current === null || current.older !== older) return current;
          return prependOlderEntries(current, snapshot.entries, snapshot.older);
        });
      } catch {
        // The conversation moved under the cursor (a rewind): re-read the
        // newest window, which leaves a cursor that exists.
        try {
          const snapshot = await stellaApi.getSnapshot(agentId);
          setConversation((current) =>
            current === null ? current : stellaStateOf(snapshot, current),
          );
        } catch {
          // The next scroll attempt tries again.
        }
      } finally {
        olderInFlight.current = false;
        setLoadingOlder(false);
      }
    })();
    return true;
  }, [activeAgentId, conversation?.older]);

  return {
    agents,
    // Only the very first read counts: a 30-second refresh replaces rows that
    // are already on screen, and swapping them for "Loading…" would take real
    // content away to say nothing new.
    agentsLoading: enabled && !agentsSettled,
    activeAgentId,
    conversation,
    loadOlder,
    loadingOlder,
    sessionId,
    prompt,
    abort,
    answer,
    rewind,
    finishHandover,
    provideEnv,
    declineEnv,
    error,
    loading,
    reloadAgents,
    applyAgent,
  };
}
