import { type Dispatch, type SetStateAction, useCallback, useRef } from "react";
import { api, fed, sessionApi } from "../api.ts";
import {
  setModelThinkingLevel,
  syncThinkingLevelInViews,
} from "../providers.ts";
import {
  type AskAnswer,
  emptyView,
  type FederatedWorkspace,
  type ModePrompt,
  type PendingImage,
  type SessionView,
  type ThinkingLevel,
} from "../types.ts";
import type { ComposerModel } from "../components/Composer.tsx";
import { DRAFT_TAB } from "./useTabs.ts";
import { splitTabKey, tabKey } from "../tabs.ts";

export interface UseSessionActionsOptions {
  setTabs: Dispatch<SetStateAction<string[]>>;
  setActiveTab: Dispatch<SetStateAction<string | null>>;
  setViews: Dispatch<SetStateAction<Map<string, SessionView>>>;
  setViewError: (key: string, error: unknown) => void;
  /** Key of the active tab; its peer half routes thinking-level updates. */
  activeTab: string | null;
}

/** Session operations of the App: creating a session from the draft tab,
 * prompting/aborting/answering/rewinding an open one, switching its model,
 * and updating a model's thinking level (a per-model server setting that
 * every view of the same peer+model reflects). */
export function useSessionActions(
  { setTabs, setActiveTab, setViews, setViewError, activeTab }:
    UseSessionActionsOptions,
) {
  // Serial number for model switches: a stale response is discarded.
  const modelChangeSeq = useRef(0);

  /** Create a session from the draft tab and send the first prompt. The
   * session runs on the peer that owns the workspace (remote workspaces
   * use the peer's default model). A chat entry (workspace.chat) starts a
   * "simple chat" session: no workspaceId is sent, so the server creates
   * it in its folder-less chat workspace. `mode` marks the first prompt
   * as a mode prompt (e.g. plan mode): the server stores a ModeMessage
   * (short text + badge) instead of a plain user message. */
  const startSession = useCallback(
    async (
      fws: FederatedWorkspace,
      model: ComposerModel | null,
      text: string,
      images: PendingImage[],
      mode?: ModePrompt,
    ) => {
      const { peerId, workspace } = fws;
      const session = peerId === ""
        ? await api.createSession({
          ...(workspace.chat ? {} : { workspaceId: workspace.id }),
          ...(model
            ? { modelProvider: model.provider, modelId: model.modelId }
            : {}),
        })
        : await fed.createSession(
          peerId,
          workspace.chat ? {} : { workspaceId: workspace.id },
        );
      const key = tabKey(peerId, session.id);
      setTabs((prev) => {
        if (prev.includes(DRAFT_TAB)) {
          return prev.map((t) => (t === DRAFT_TAB ? key : t));
        }
        return [...prev, key];
      });
      setActiveTab(key);
      setViews((prev) => {
        const next = new Map(prev);
        next.set(key, emptyView(session));
        return next;
      });
      try {
        await sessionApi(key).prompt(text.trim(), images, mode);
      } catch (error) {
        setViewError(key, error);
      }
    },
    [setTabs, setActiveTab, setViews, setViewError],
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
      // (message_start), so no optimistic append is needed.
      try {
        await sessionApi(key).prompt(textTrimmed, images, mode);
      } catch (error) {
        setViewError(key, error);
      }
    },
    [setViewError],
  );

  const abort = useCallback((key: string) => {
    sessionApi(key).abort().catch(console.error);
  }, []);

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
        console.error(error);
      }
    },
    [setViews],
  );

  /** The thinking level is a per-model setting on the owning server:
   * update the views of every open session on the same peer that uses
   * that model so the control stays in sync. */
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
        console.error(error);
      }
    },
    [activeTab, setViews],
  );

  return {
    startSession,
    prompt,
    abort,
    answer,
    rewind,
    changeModel,
    changeThinkingLevel,
  };
}
