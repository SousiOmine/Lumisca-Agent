import { memo, useCallback } from "preact/compat";
import type {
  AskAnswer,
  ModePrompt,
  PendingImage,
  SessionView,
  ThinkingLevel,
  Workspace,
} from "../types.ts";
import { DRAFT_TAB, splitTabKey } from "../tabs.ts";
import type { TabDraft } from "../hooks/useDrafts.ts";
import type { SessionActions } from "../hooks/useSessionActions.ts";
import { ChatView } from "./ChatView.tsx";
import type { ComposerModel } from "./Composer.tsx";
import { NewSessionView } from "./NewSessionView.tsx";

/**
 * One code-mode screen, kept mounted for as long as its tab is open.
 *
 * Building the view is what a tab switch must not do. Constructing it means
 * grouping the loaded window into turns, parsing every message's markdown and
 * creating the DOM for it, and then measuring the result to jump to the
 * bottom; the window holds up to 200 rows, so on a slow machine one switch
 * blocks rendering for several hundred milliseconds, and switching back and
 * forth pays that again every time.
 *
 * So the App draws one pane per open tab and hides the ones the address does
 * not name. A switch is then an attribute change: the engine lays the pane out
 * again but builds none of it. Panes are memoized because the App re-renders on
 * every streamed event; the props below are stable by construction (see
 * SessionActions, useDrafts and useTabs), so a hidden pane is not diffed while
 * another session streams. What being hidden stops is not only rendering:
 * `active` also stops the transcript's follow/page rules and the field's
 * measurement, which would read a box-less element as zero.
 *
 * The pane is unmounted when its tab is closed (the App draws the open tabs
 * only), so the memory this trades for the switch is bounded by what the reader
 * has open.
 */

interface SessionPaneProps {
  /** Composite tab key (see tabs.ts): the session this pane shows. */
  tabKey: string;
  view: SessionView;
  /** Whether this pane is the one the address names. */
  active: boolean;
  draft: TabDraft;
  loadingOlder: boolean;
  actions: SessionActions;
  /** Read the window before the loaded one (returns whether a read started). */
  loadOlder: (key: string) => boolean;
  updateDraft: (key: string, patch: Partial<TabDraft>) => void;
  onOpenSettings: () => void;
}

export const SessionPane = memo(function SessionPane(
  {
    tabKey,
    view,
    active,
    draft,
    loadingOlder,
    actions,
    loadOlder,
    updateDraft,
    onOpenSettings,
  }: SessionPaneProps,
) {
  const onInputChange = useCallback(
    (input: string) => updateDraft(tabKey, { input }),
    [updateDraft, tabKey],
  );
  const onImagesChange = useCallback(
    (images: PendingImage[]) => updateDraft(tabKey, { images }),
    [updateDraft, tabKey],
  );
  const onPrompt = useCallback(
    (text: string, images: PendingImage[], mode?: ModePrompt) =>
      actions.prompt(tabKey, text, images, mode),
    [actions, tabKey],
  );
  const onAbort = useCallback(() => actions.abort(tabKey), [actions, tabKey]);
  const onRewind = useCallback(
    (timestamp: number) => actions.rewind(tabKey, timestamp),
    [actions, tabKey],
  );
  const onAnswer = useCallback(
    (toolCallId: string, answers: AskAnswer[]) =>
      actions.answer(tabKey, toolCallId, answers),
    [actions, tabKey],
  );
  const onModelChange = useCallback(
    (provider: string, modelId: string) =>
      actions.changeModel(tabKey, provider, modelId),
    [actions, tabKey],
  );
  // The model the control names is the one the pane shows, so the level is
  // saved against that model rather than against whatever the active tab has.
  const { modelProvider, modelId } = view.info;
  const onThinkingLevelChange = useCallback(
    (level: ThinkingLevel) =>
      actions.changeThinkingLevel(tabKey, modelProvider, modelId, level),
    [actions, tabKey, modelProvider, modelId],
  );
  const onActionCommand = useCallback(
    (commandId: string, instructions?: string) => {
      if (commandId === "compact") actions.compact(tabKey, instructions);
    },
    [actions, tabKey],
  );
  const onLoadOlder = useCallback(() => loadOlder(tabKey), [loadOlder, tabKey]);

  return (
    <ChatView
      view={view}
      active={active}
      peerId={splitTabKey(tabKey).peerId}
      input={draft.input}
      onInputChange={onInputChange}
      images={draft.images}
      onImagesChange={onImagesChange}
      onPrompt={onPrompt}
      onAbort={onAbort}
      onRewind={onRewind}
      onAnswer={onAnswer}
      onModelChange={onModelChange}
      onThinkingLevelChange={onThinkingLevelChange}
      onActionCommand={onActionCommand}
      onLoadOlder={onLoadOlder}
      loadingOlder={loadingOlder}
      onOpenSettings={onOpenSettings}
    />
  );
});

interface DraftPaneProps {
  active: boolean;
  draft: TabDraft;
  workspaces: Workspace[];
  workspacesLoaded: boolean;
  settingsVersion: number;
  updateDraft: (key: string, patch: Partial<TabDraft>) => void;
  clearDraft: (key: string) => void;
  startSession: (
    workspace: Workspace,
    model: ComposerModel | null,
    text: string,
    images: PendingImage[],
    mode?: ModePrompt,
  ) => Promise<void>;
  onWorkspaceChanged: (workspace: Workspace) => void;
  onDeleteWorkspace: (workspace: Workspace) => Promise<void>;
  onReopenSession: (key: string) => void;
  onOpenSettings: () => void;
}

/** The new-session screen, kept mounted the same way once it has been shown:
 * reopening it used to re-read the default model, the skill catalog and the
 * recent session list (which probes every registered peer) on every visit.
 * The App mounts it lazily — a launch that opens a session directly still
 * makes none of those requests. */
export const DraftPane = memo(function DraftPane(
  {
    active,
    draft,
    workspaces,
    workspacesLoaded,
    settingsVersion,
    updateDraft,
    clearDraft,
    startSession,
    onWorkspaceChanged,
    onDeleteWorkspace,
    onReopenSession,
    onOpenSettings,
  }: DraftPaneProps,
) {
  const onInputChange = useCallback(
    (input: string) => updateDraft(DRAFT_TAB, { input }),
    [updateDraft],
  );
  const onImagesChange = useCallback(
    (images: PendingImage[]) => updateDraft(DRAFT_TAB, { images }),
    [updateDraft],
  );
  const onStart = useCallback(
    async (
      workspace: Workspace,
      model: ComposerModel | null,
      text: string,
      images: PendingImage[],
      mode?: ModePrompt,
    ) => {
      await startSession(workspace, model, text, images, mode);
      // The draft screen is left by the navigation startSession made; its text
      // was sent, so discard it (kept on failure so the user can retry).
      clearDraft(DRAFT_TAB);
    },
    [startSession, clearDraft],
  );

  return (
    <NewSessionView
      active={active}
      workspaces={workspaces}
      workspacesLoaded={workspacesLoaded}
      input={draft.input}
      onInputChange={onInputChange}
      images={draft.images}
      onImagesChange={onImagesChange}
      onStart={onStart}
      onWorkspaceChanged={onWorkspaceChanged}
      onDeleteWorkspace={onDeleteWorkspace}
      onReopenSession={onReopenSession}
      onOpenSettings={onOpenSettings}
      settingsVersion={settingsVersion}
    />
  );
});
