import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useRef,
} from "preact/compat";
import { api, sessionApi } from "../api.ts";
import {
  setModelThinkingLevel,
  syncThinkingLevelInViews,
} from "../providers.ts";
import {
  type AskAnswer,
  emptyView,
  type ModePrompt,
  type PendingImage,
  type SessionView,
  type ThinkingLevel,
  type Workspace,
} from "../types.ts";
import type { ComposerModel } from "../components/Composer.tsx";
import { splitTabKey, tabKey } from "../tabs.ts";
import { summarizeContextUsage } from "@lumisca/core/shared";

export interface UseSessionActionsOptions {
  setViews: Dispatch<SetStateAction<Map<string, SessionView>>>;
  setViewError: (key: string, error: unknown) => void;
  /** Key of the active tab; its peer half routes thinking-level updates. */
  activeTab: string | null;
  /** A session was created and its first prompt was sent. The caller
   * navigates to the new session's address: the URL is what says which
   * session is open, so a started session is a move, not a state change. */
  onCreated: (key: string) => void;
}

/** Session operations of the App: creating a session from the draft tab,
 * prompting/aborting/answering/rewinding an open one, switching its model,
 * and updating a model's thinking level (a per-model server setting that
 * every view of the same peer+model reflects). */
export function useSessionActions(
  { setViews, setViewError, activeTab, onCreated }: UseSessionActionsOptions,
) {
  // Serial number for model switches: a stale response is discarded.
  const modelChangeSeq = useRef(0);

  /** Create a session and send the first prompt. The session runs on this
   * server: a remote workspace is not offered on the new session screen any
   * more (the desktop title bar picks the machine, one server at a time). A
   * chat workspace starts a "simple chat" session: no workspaceId is sent, so
   * the server creates it in its folder-less chat workspace. `mode` marks the
   * first prompt as a mode prompt (e.g. plan mode): the server stores a
   * ModeMessage (short text + badge) instead of a plain user message. */
  const startSession = useCallback(
    async (
      workspace: Workspace,
      model: ComposerModel | null,
      text: string,
      images: PendingImage[],
      mode?: ModePrompt,
    ) => {
      const session = await api.createSession({
        ...(workspace.chat ? {} : { workspaceId: workspace.id }),
        ...(model
          ? { modelProvider: model.provider, modelId: model.modelId }
          : {}),
      });
      const key = tabKey("", session.id);
      const view = emptyView(session, {
        messages: [],
        older: null,
        usage: summarizeContextUsage([]),
      });
      setViews((prev) => {
        const next = new Map(prev);
        // A new session has no transcript and nothing to count: the run's
        // messages and their usage arrive as events. Its view is placed
        // here, BEFORE the navigation below: the address reaches the tab
        // strip on the next render, and a tab whose view is missing would
        // read the session it just created.
        next.set(key, view);
        return next;
      });
      // The address is what opens the session (see useTabs): the tab strip
      // and the body both follow it, so the session appears as a result of
      // this move rather than beside it.
      onCreated(key);
      // Both failures leave this function as a rejection: the caller keeps
      // the text it was about to send (the composer restores it), and the
      // view shows why. Swallowing them here is what made a failed first
      // prompt lose the draft.
      await sessionApi(key).prompt(text.trim(), images, mode);
    },
    [setViews, onCreated],
  );

  const prompt = useCallback(
    async (
      key: string,
      text: string,
      images: PendingImage[],
      mode?: ModePrompt,
    ) => {
      const textTrimmed = text.trim();
      if (!textTrimmed && images.length === 0) return;
      // The user message appears via the WebSocket event stream
      // (message_start), so no optimistic append is needed. A failure is
      // both shown on the view and rethrown: the composer keeps the text
      // (see ChatView.submit).
      try {
        await sessionApi(key).prompt(textTrimmed, images, mode);
      } catch (error) {
        setViewError(key, error);
        throw error;
      }
    },
    [setViewError],
  );

  /** Abort the running exchange. The failure surfaces on the view (the
   * banner above the composer): a silently ignored abort would leave the
   * user pressing a button that does nothing. */
  const abort = useCallback((key: string) => {
    sessionApi(key).abort().catch((error) => setViewError(key, error));
  }, [setViewError]);

  /** Answer a pending ask (the ask tool): the answer is sent to the server
   * owning the session, which resolves the blocked run. Errors surface in
   * the question panel (the question may already be gone, e.g. after a
   * rewind). */
  const answer = useCallback(
    async (key: string, toolCallId: string, answers: AskAnswer[]) => {
      await sessionApi(key).answer(toolCallId, answers);
    },
    [],
  );

  /** Rewind the transcript from a user message onward (deletes the message
   * and everything after it; an active run is aborted server-side first).
   * The error is rethrown after being shown so the caller (ChatView) does
   * not restore the text to the composer when nothing was deleted. */
  const rewind = useCallback(
    async (key: string, timestamp: number) => {
      try {
        await sessionApi(key).rewind(timestamp);
      } catch (error) {
        setViewError(key, error);
        throw error;
      }
    },
    [setViewError],
  );

  /** Condense the session's older history into a checkpoint on demand (the
   * `/compact [instructions]` command). `instructions` is the user's extra
   * focus for the summary. The event stream carries the resulting
   * `messages_checkpoint` update, so nothing is applied here; a failure
   * surfaces on the view. */
  const compact = useCallback(
    (key: string, instructions?: string) => {
      sessionApi(key).compact(instructions).catch((error) =>
        setViewError(key, error)
      );
    },
    [setViewError],
  );

  const changeModel = useCallback(
    async (key: string, provider: string, modelId: string) => {
      const seq = ++modelChangeSeq.current;
      try {
        const updated = await sessionApi(key).updateModel(provider, modelId);
        // A newer switch may have resolved first; never show a stale model.
        if (modelChangeSeq.current !== seq) return;
        setViews((prev) => {
          const current = prev.get(key);
          if (!current) return prev;
          const next = new Map(prev);
          next.set(key, { ...current, info: updated });
          return next;
        });
      } catch (error) {
        setViewError(key, error);
      }
    },
    [setViews, setViewError],
  );

  /** The thinking level is a per-model setting on the owning server:
   * update the views of every open session on the same peer that uses
   * that model so the control stays in sync. The failure surfaces on the
   * active tab's view (the control belongs to the open session). */
  const changeThinkingLevel = useCallback(
    async (
      provider: string,
      modelId: string,
      level: ThinkingLevel,
    ) => {
      const { peerId } = activeTab ? splitTabKey(activeTab) : { peerId: "" };
      try {
        const thinkingLevel = await setModelThinkingLevel(
          peerId,
          provider,
          modelId,
          level,
        );
        setViews((prev) =>
          syncThinkingLevelInViews(
            prev,
            peerId,
            provider,
            modelId,
            thinkingLevel,
          )
        );
      } catch (error) {
        if (activeTab) setViewError(activeTab, error);
      }
    },
    [activeTab, setViews, setViewError],
  );

  return {
    startSession,
    prompt,
    abort,
    answer,
    rewind,
    compact,
    changeModel,
    changeThinkingLevel,
  };
}
