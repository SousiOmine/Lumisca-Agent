import { errorMessage, PROMPT_UPLOAD_CHUNK_BYTES } from "@lumisca/core/shared";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError } from "../api-client.ts";
import { connectStellaEvents, stellaApi } from "../api-stella.ts";
import { describeError, useT } from "../i18n.ts";
import {
  maybeNotifyAgentEnd,
  maybeNotifyEnv,
  maybeNotifyHandover,
  maybeNotifyShare,
} from "../notify.ts";
import {
  cancelPromptUpload,
  completePromptUpload,
  createPromptUpload,
  getPromptUpload,
  putPromptUploadChunk,
  sha256Hex,
} from "../prompt-upload.ts";
import { inDesktopShell, shellCall } from "../shell.ts";
import {
  applyStellaEvent,
  prependOlderEntries,
  type StellaConversationState,
  stellaStateOf,
  truncateFrom,
} from "../stella-state.ts";
import type {
  PendingFile,
  PendingImage,
  PromptUploader,
  PromptUploadHandle,
  StellaEvent,
} from "../types.ts";
import { startRevisionProbe } from "./useRevisionProbe.ts";
import { createStreamController } from "./useStreamController.ts";

/**
 * One stella conversation: the state the transcript draws, the event stream
 * that advances it, and the requests a reader makes on it (send, upload,
 * abort, answer, rewind, hand over, hand the run a value or a folder, page
 * back).
 *
 * WHICH conversation is open is not this hook's to decide: the address names
 * the agent (`/agents/<id>`), and the caller passes that id in and drops the
 * state when it moves on. Nothing here reaches the code-mode tab views — a
 * conversation has its own endpoints and its own stream (api-stella.ts).
 *
 * The machine is not part of this hook's API because it is not part of the
 * user's: the server starts it when the conversation is requested, and the one
 * consequence the client shows is `starting` on the status it already polls.
 */
export type StellaConversationHook = {
  /** The agent's conversation, or null before it is open. */
  conversation: StellaConversationState | null;
  /** The agent that conversation belongs to. Kept apart from the address for
   * the frame in which the address has moved on but the state has not been
   * dropped yet (see useStella's row preview). */
  conversationAgentId: string | null;
  sessionId: string | null;
  prompt: (
    text: string,
    images?: PendingImage[],
    files?: PendingFile[],
  ) => Promise<void>;
  uploadFile: PromptUploader;
  abort: () => void;
  answer: (
    toolCallId: string,
    answers: { id: string; values: string[] }[],
  ) => Promise<void>;
  rewind: (timestamp: number) => Promise<void>;
  finishHandover: (note: string, toolCallId: string) => Promise<void>;
  provideEnv: (value: string, toolCallId: string) => Promise<void>;
  declineEnv: (toolCallId: string) => Promise<void>;
  lendShare: (toolCallId: string) => Promise<void>;
  declineShare: (toolCallId: string) => Promise<void>;
  loadOlder: () => boolean;
  loadingOlder: boolean;
  /** The open is in flight (the server starts the machine on it). */
  loading: boolean;
};

export function useStellaConversation(
  enabled: boolean,
  activeAgentId: string | null,
  activeAgentDisabled: boolean,
  setError: (failure: string | null) => void,
): StellaConversationHook {
  // Failure text is written in the language the app is in when it happens
  // (the hook holds strings, not failure objects).
  const t = useT();
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
  const [loading, setLoading] = useState(false);
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

  // Open the active agent's conversation. The server starts the machine on
  // this call, so a first run waits here (minutes) — `loading` is what the
  // view shows during it. A disabled agent's open is read-only and starts
  // nothing, which is why flipping the switch has to re-run it.
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
  }, [enabled, activeAgentId, activeAgentDisabled, t, setError]);

  // A read-only conversation has no events to receive: its agent is switched
  // off, so nothing can be running. Opening the socket anyway left it silent
  // for as long as the tab stayed open.
  const conversationReadOnly = conversation?.disabled === true;

  // The conversation's event stream. One socket per open conversation; a
  // drop re-reads the snapshot (the events are never replayed) and
  // reconnects with backoff. Revision probes cover the frames that were
  // emitted while the socket looked open.
  useEffect(() => {
    if (
      !enabled ||
      activeAgentId === null ||
      conversation === null ||
      conversationReadOnly
    ) {
      return;
    }
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
    /** The `share_request` card already announced (only a lend request is:
     * a disconnect asks the user nothing). */
    let notifiedShare: string | null = null;

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
        if (
          event.type === "share_request" &&
          event.request !== null &&
          event.request.kind === "lend" &&
          event.request.toolCallId !== notifiedShare
        ) {
          notifiedShare = event.request.toolCallId;
          void maybeNotifyShare(
            conversationRef.current?.agentName ?? "",
            event.request.reason,
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
    // change would reconnect per message, so only the agent, the "has an
    // open conversation" flag and "is it read-only" are dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, activeAgentId, conversation !== null, conversationReadOnly]);

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

  /** The disconnect already carried out by this window. A `share_disconnect`
   * request is read again by every resync (the snapshot carries it while the
   * run waits), and the shell call must happen once per request. */
  const answeredDisconnect = useRef<string | null>(null);

  // A `share_disconnect` is the desktop shell's to carry out: it owns the
  // loan, and the server only hears the shorter list afterwards. The page is
  // the one channel between the two, so it acts on the request here — no
  // question is put to the user, because ending a loan takes nothing away
  // from them. A window that is not inside the shell (a browser tab on the
  // same server) says so instead, so the blocked tool learns why rather than
  // waiting for its deadline.
  useEffect(() => {
    const request = conversation?.shareRequest ?? null;
    if (request === null || request.kind !== "disconnect") return;
    if (activeAgentId === null) return;
    if (answeredDisconnect.current === request.toolCallId) return;
    answeredDisconnect.current = request.toolCallId;
    const agentId = activeAgentId;
    const { toolCallId, id } = request;
    void (async () => {
      if (!inDesktopShell()) {
        await stellaApi.finishShareDisconnect(
          agentId,
          toolCallId,
          false,
          "The folder is on the user's computer, and this page is not open in " +
            "the desktop app there, so the loan cannot be ended from here",
        );
        return;
      }
      try {
        await shellCall("share/revoke", { id });
        await stellaApi.finishShareDisconnect(agentId, toolCallId, true);
      } catch (failure) {
        await stellaApi.finishShareDisconnect(
          agentId,
          toolCallId,
          false,
          errorMessage(failure),
        );
      }
    })().catch(() => {
      // The answer did not settle anything: the answer never reached the
      // server (the socket dropped, the server restarted), or another window
      // showing the same conversation answered first and this one was told
      // there is nothing waiting. The tool's own deadline reports the first
      // case to the agent; the second needs no report at all. Nothing is
      // shown here either way: no card was ever drawn for this request.
    });
  }, [conversation?.shareRequest, activeAgentId]);

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

  const uploadFile = useCallback<PromptUploader>(
    (file, onProgress): PromptUploadHandle => {
      const agentId = requireAgent();
      const controller = new AbortController();
      let uploadId: string | undefined;
      const done = (async (): Promise<string> => {
        const created = await createPromptUpload(
          agentId,
          file.name,
          file.size,
          controller.signal,
        );
        uploadId = created.id;
        let offset = 0;
        for (let position = 0; position < file.size; ) {
          controller.signal.throwIfAborted();
          const end = Math.min(position + PROMPT_UPLOAD_CHUNK_BYTES, file.size);
          const bytes = new Uint8Array(
            await file.slice(position, end).arrayBuffer(),
          );
          const hash = await sha256Hex(bytes);
          let reported = offset;
          const result = await putPromptUploadChunk(
            agentId,
            uploadId,
            offset,
            bytes,
            hash,
            (loaded) => {
              const sent = offset + loaded;
              if (sent - reported >= 1024 * 1024 || loaded === bytes.length) {
                reported = sent;
                onProgress({ uploaded: sent, status: "uploading" });
              }
            },
            controller.signal,
          );
          offset = result.offset;
          position = end;
          onProgress({ uploaded: offset, status: "uploading" });
        }
        await completePromptUpload(agentId, uploadId, controller.signal);
        onProgress({ uploaded: file.size, status: "copying" });
        // The server's own copy timeout is 30 minutes; this one is longer so
        // the server's message, not a client guess, is what the reader sees.
        const deadline = Date.now() + 35 * 60_000;
        for (;;) {
          controller.signal.throwIfAborted();
          const state = await getPromptUpload(
            agentId,
            uploadId,
            controller.signal,
          );
          if (state.status === "completed") return uploadId;
          if (state.status === "failed") {
            // The server answered, so the failure is the server's to explain.
            // Its sentence travels as the detail the UI appends to the
            // localized line.
            throw new ApiError(
              state.error ?? t("chat.composer.attach.copyFailed"),
              "http-5xx",
              { detail: state.error ?? null },
            );
          }
          if (Date.now() > deadline) {
            throw new ApiError(
              t("chat.composer.attach.copyFailed"),
              "http-5xx",
              { detail: "The machine did not finish the copy in 35 minutes" },
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      })().catch((failure: unknown) => {
        if (uploadId !== undefined) {
          void cancelPromptUpload(agentId, uploadId).catch(() => {
            // The store's retention sweeps what this could not remove.
          });
        }
        // A transport abort is the composer's own cancel, not an outage. The
        // hook uses the DOM's name to drop the chip instead of showing a
        // network failure the reader did not have.
        if (controller.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        throw failure;
      });
      return {
        done,
        cancel() {
          controller.abort();
          if (uploadId !== undefined) {
            void cancelPromptUpload(agentId, uploadId).catch(() => {
              // The store's retention sweeps what this could not remove.
            });
          }
        },
      };
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
      // The truncation also arrives as the conversation's own `truncated`
      // event. Applying the answer here as well makes the view right the
      // moment the request settles — even while the socket is between
      // connections — and the event that follows finds nothing left to drop.
      // The button sits on a user's message, and that is where the server cut
      // (the first user message with this timestamp, see the core's Rewinder).
      setConversation((current) =>
        current === null
          ? current
          : (truncateFrom(current, { role: "user", timestamp }) ?? current),
      );
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

  const lendShare = useCallback(
    async (toolCallId: string) => {
      await stellaApi.lendShare(requireAgent(), toolCallId);
    },
    [requireAgent],
  );

  const declineShare = useCallback(
    async (toolCallId: string) => {
      await stellaApi.declineShare(requireAgent(), toolCallId);
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
    conversation,
    conversationAgentId,
    sessionId,
    prompt,
    uploadFile,
    abort,
    answer,
    rewind,
    finishHandover,
    provideEnv,
    declineEnv,
    lendShare,
    declineShare,
    loadOlder,
    loadingOlder,
    loading,
  };
}
