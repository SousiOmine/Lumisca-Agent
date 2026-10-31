import { useEffect, useMemo, useRef, useState } from "preact/compat";
import { IconArrowUp } from "@tabler/icons-preact";
import { api } from "../api.ts";
import type {
  ModelInfo,
  ModePrompt,
  PendingImage,
  ThinkingLevel,
  Workspace,
} from "../types.ts";
import { useSavedPrompts } from "../hooks/useSavedPrompts.ts";
import { useSkills } from "../hooks/useSkills.ts";
import { useAsyncEffect } from "../hooks/useAsync.ts";
import { useT } from "../i18n.ts";
import { errorText, setModelThinkingLevel } from "../providers.ts";
import {
  actionCommandFromText,
  buildSlashCommands,
  skillPromptFromText,
  slashPrompt,
  slashPromptFromText,
} from "../slashCommands.ts";
import {
  Composer,
  type ComposerModel,
  type SlashCommand,
  type SlashCommandItem,
} from "./Composer.tsx";
import { RecentSessionsList } from "./RecentSessionsList.tsx";
import { useRecentSessions } from "../hooks/useRecentSessions.ts";
import { WorkspaceModal } from "./WorkspaceModal.tsx";
import { WorkspacePicker } from "./WorkspacePicker.tsx";

/** The draft screen never has a session tab open, so every session in the
 * recent list is reopenable as-is. */
const NO_OPEN_SESSIONS: ReadonlySet<string> = new Set();

/** The model plus the thinking levels it supports, so the draft tab's
 * thinking control can render without an extra fetch. */
interface DraftModel extends ComposerModel {
  thinkingLevel?: ThinkingLevel;
  thinkingLevels?: ThinkingLevel[];
}

interface NewSessionViewProps {
  workspaces: Workspace[];
  /** Whether the workspace list has arrived (initial data counts as
   * loaded; a failed load counts too). While false a restored workspace
   * key is kept as-is and re-validated once the list lands. */
  workspacesLoaded: boolean;
  /** Draft (unsent) composer content, owned by the App under the draft
   * tab key so it survives switching away and back. */
  input: string;
  onInputChange: (value: string) => void;
  images: PendingImage[];
  onImagesChange: (images: PendingImage[]) => void;
  onStart: (
    workspace: Workspace,
    model: ComposerModel | null,
    text: string,
    images: PendingImage[],
    /** Set when the first prompt is a mode prompt (e.g. plan mode): the
     * session starts with a ModeMessage (short text + badge) instead of
     * a plain user message. */
    mode?: ModePrompt,
  ) => Promise<void>;
  onWorkspaceChanged: (workspace: Workspace) => void;
  /** The single delete flow owned by the App (confirm + API + state). */
  onDeleteWorkspace: (workspace: Workspace) => Promise<void>;
  /** Reopen a closed session in a tab (recent sessions list). */
  onReopenSession: (key: string) => void;
  /** Open the provider settings from the model picker's "設定画面" link. */
  onOpenSettings?: () => void;
  /** Bumped by the App every time the settings dialog closes. Registering
   * a provider there changes what a new session's model resolves to, so
   * the draft re-reads the default model instead of keeping the "no
   * provider configured" verdict until a reload (the model picker itself
   * follows through the shared catalog store). */
  settingsVersion: number;
}

/** Sentinel workspace id of the pinned chat entry: selecting it starts a
 * chat session without a workspace (the server creates its own chat
 * workspace). Never a real row; excluded from the regular picker list. */
const CHAT_ENTRY_ID = "@chat";

/** The pinned "chat without a workspace" entry, shown first in the picker
 * when no stored workspace applies. */
function chatEntry(name: string): Workspace {
  return {
    id: CHAT_ENTRY_ID,
    name,
    folders: [],
    createdAt: 0,
    chat: true,
  };
}

/** localStorage key for the workspace last picked on the new session
 * screen, so the same one is selected again after a restart. */
const LAST_WORKSPACE_KEY = "lumisca.draftWorkspace";

function loadLastWorkspaceKey(): string {
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** The draft session tab: pick workspace/model and start from the center.
 * The workspaces are those of the server this window displays; another
 * machine is a different view of the app, reached from the desktop title
 * bar's connection picker (which navigates the window there). */
export function NewSessionView(
  {
    workspaces,
    workspacesLoaded,
    input,
    onInputChange,
    images,
    onImagesChange,
    onStart,
    onWorkspaceChanged,
    onDeleteWorkspace,
    onReopenSession,
    onOpenSettings,
    settingsVersion,
  }: NewSessionViewProps,
) {
  // The last selected workspace, restored from localStorage. Kept in a ref
  // until the (possibly async) workspace list can validate it.
  const pendingWorkspaceKey = useRef<string | null>(loadLastWorkspaceKey());
  /** Message lookup of the app language (the slash menu's labels are
   * catalogue entries). */
  const t = useT();
  const [workspaceId, setWorkspaceId] = useState(
    pendingWorkspaceKey.current ?? "",
  );
  const [model, setModel] = useState<DraftModel | null>(null);
  const [modalWorkspace, setModalWorkspace] = useState<
    Workspace | undefined
  >(undefined);
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const modelTouched = useRef(false);
  const recent = useRecentSessions();

  // --- saved prompts (shared hook so the menu refreshes after the settings
  // panel mutates the list) ----------------------------------------------
  const { prompts: savedPrompts } = useSavedPrompts();
  /** Why the default model could not be resolved; shown above the picker so
   * the empty selection is explained instead of silently staying blank. */
  const [defaultModelError, setDefaultModelError] = useState<string | null>(
    null,
  );
  /** Whether the server answered that it has no model to offer, i.e. no
   * provider is configured. Only that definitive answer blocks starting a
   * session: an unanswered or failed fetch leaves the draft working as
   * before (the server resolves its own default). */
  const [noDefaultModel, setNoDefaultModel] = useState(false);

  // Show the last used model (the one a session without an explicit model
  // would get) right away instead of leaving the picker to choose on click.
  // A selection the user already made is never overwritten by the late
  // response. Re-read when the settings dialog closes (`settingsVersion`):
  // registering a provider there makes the server resolve a model, and
  // removing a key takes it away again.
  useAsyncEffect(async (isStale) => {
    try {
      const m = await api.getDefaultModel();
      if (isStale()) return;
      setDefaultModelError(null);
      setNoDefaultModel(m === null);
      if (!modelTouched.current) {
        // A null answer clears a previously resolved model too: the draft
        // must not keep offering a model whose provider is gone.
        setModel(
          m === null ? null : {
            provider: m.provider,
            modelId: m.modelId,
            thinkingLevel: m.thinkingLevel,
            thinkingLevels: m.thinkingLevels,
          },
        );
      }
    } catch (error) {
      // Non-critical for starting a session (the server resolves its own
      // default), but the user must know why the picker is empty.
      if (!isStale()) setDefaultModelError(errorText(error));
    }
  }, [settingsVersion]);

  // The server already hides chat workspaces from the list API; the flag
  // filter here is defensive (e.g. against an older server), since chat rows
  // are never user-manageable.
  const pickerWorkspaces = workspaces.filter((w) => !w.chat);
  const chatOption = chatEntry(t("chat.newSession.chatName"));
  const selectable = [chatOption, ...pickerWorkspaces];

  // A draft cannot start without a model, and with no provider configured
  // the server has none to offer: the field stays unset and the start button
  // is disabled, instead of creating a session on a model that could not
  // stream.
  const noModelToStart = model === null && noDefaultModel;

  // Keep a valid selection when the workspace list changes (e.g. after a
  // delete); fall back to the chat entry when nothing else remains. A
  // restored id (localStorage) is applied once the list has arrived: it is
  // kept verbatim while the list is still loading — an empty list and "not
  // loaded yet" are indistinguishable by length alone, so the explicit
  // `workspacesLoaded` flag gates the validation. After the list lands (even
  // with zero workspaces), an unknown restored id falls back to the chat
  // entry, never leaving the draft screen stuck on a workspace that is not
  // there.
  useEffect(() => {
    const fallback = CHAT_ENTRY_ID;
    setWorkspaceId((current) => {
      const pending = pendingWorkspaceKey.current;
      if (pending !== null) {
        pendingWorkspaceKey.current = null;
        if (!workspacesLoaded) return pending;
        return selectable.some((w) => w.id === pending) ? pending : fallback;
      }
      return selectable.some((w) => w.id === current) ? current : fallback;
    });
  }, [workspaces, workspacesLoaded]);

  // Remember the last selected workspace so it can be restored on the next
  // visit to the new session screen (after a restart or tab switch).
  useEffect(() => {
    try {
      if (workspaceId) {
        localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);
      } else {
        localStorage.removeItem(LAST_WORKSPACE_KEY);
      }
    } catch {
      // ignore storage failures
    }
  }, [workspaceId]);

  const selectedWorkspace = selectable.find((w) => w.id === workspaceId);

  // Build the slash commands list including the /skill and /prompt submenus.
  // In chat mode only skills, actions and saved prompts are shown (agent
  // modes need a workspace).
  const isChat = selectedWorkspace?.chat ?? false;
  // The skills of the selected workspace (the `/skill` palette); a chat
  // draft asks for a chat session's skills (global and built-in only),
  // exactly like the session it starts.
  const { skills } = useSkills("", isChat ? undefined : selectedWorkspace?.id);
  const allSlashCommands = useMemo<SlashCommand[]>(
    () => buildSlashCommands(savedPrompts, isChat, skills, t),
    [isChat, savedPrompts, skills, t],
  );

  /** Start the session with the composer text, or an explicit message. The
   * draft is cleared by the App once the session started; on failure it
   * stays so the user can retry. `mode` marks the message as a mode
   * prompt (ModeMessage in the transcript).
   *
   * Composer text the menu completed in place is resolved here even when
   * the menu was bypassed (send button, Ctrl+Enter): a text-taking mode
   * (`/plan 依頼文` — workspace drafts only, modes need a workspace) or the
   * skill palette (`/skill 名前 依頼文`, which a chat draft has too). An
   * incomplete command line (`/plan` without a request, `/skill` without a
   * skill name) sends nothing. */
  const submit = async (message?: string, mode?: ModePrompt) => {
    let trimmed = (message ?? input).trim();
    if (
      (!trimmed && images.length === 0) ||
      !selectedWorkspace || busy || noModelToStart
    ) {
      return;
    }
    if (message === undefined) {
      // Client-side actions need a session to condense, and this composer
      // starts one: the text is left in the composer instead of being sent
      // as a prompt.
      if (actionCommandFromText(trimmed) !== null) return;
      // Modes next: their token is a mode id, so the two never collide.
      const line = (isChat ? null : slashPromptFromText(trimmed, t)) ??
        skillPromptFromText(trimmed, skills);
      if (line !== null) {
        if (line.kind === "needs-text") return;
        trimmed = line.text;
        mode = line.mode;
      }
    }
    setBusy(true);
    setError(undefined);
    try {
      await onStart(selectedWorkspace, model, trimmed, images, mode);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  /** A `run` command was picked at the start of the input (the composer
   * handles completion and insertion itself — see Composer.applySlashPick).
   * Agent modes (existing commands) build their prompt and start the
   * session. */
  const handleSlashCommand = (
    command: SlashCommand,
    item?: SlashCommandItem,
  ) => {
    const result = slashPrompt(command, item, "", t);
    if (result !== null) {
      void submit(result.text, result.mode);
    }
  };

  const deleteWorkspace = async (workspace: Workspace) => {
    setError(undefined);
    try {
      await onDeleteWorkspace(workspace);
    } catch (e) {
      setError(errorText(e));
    }
  };

  /** Set the thinking level for the draft's model (a per-model setting on
   * this server). */
  const changeThinkingLevel = async (level: ThinkingLevel) => {
    if (!model) return;
    try {
      const thinkingLevel = await setModelThinkingLevel(
        "",
        model.provider,
        model.modelId,
        level,
      );
      setModel((current) =>
        current && current.provider === model.provider &&
          current.modelId === model.modelId
          ? { ...current, thinkingLevel }
          : current
      );
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="chat">
      <div className="chat-scroll">
        <div className="new-session-center">
          <div className="new-session-card">
            <h2>{t("chat.newSession.title")}</h2>
            <div className="new-session-select-row">
              <label className="new-session-select">
                <span>{t("chat.newSession.workspace")}</span>
                <WorkspacePicker
                  workspaces={pickerWorkspaces}
                  chat={chatOption}
                  value={workspaceId}
                  onChange={setWorkspaceId}
                  onEdit={(ws) => {
                    setModalWorkspace(ws);
                    setShowWorkspaceModal(true);
                  }}
                  onDelete={deleteWorkspace}
                  onCreate={() => {
                    setModalWorkspace(undefined);
                    setShowWorkspaceModal(true);
                  }}
                />
              </label>
            </div>
            {defaultModelError && (
              <div className="error-text" role="alert">
                {t("chat.newSession.defaultModelError")} {defaultModelError}
              </div>
            )}
            {noModelToStart && (
              <div className="settings-note" role="status">
                <span>{t("chat.newSession.noProvider")}</span>
                {onOpenSettings && (
                  <button
                    type="button"
                    className="btn small"
                    onClick={onOpenSettings}
                  >
                    {t("chrome.modelPicker.settingsLink")}
                  </button>
                )}
              </div>
            )}
            <Composer
              value={input}
              onChange={onInputChange}
              placeholder={t("chat.newSession.placeholder")}
              autoFocus
              large
              model={model}
              onModelSelect={(provider, modelId, info?: ModelInfo) => {
                modelTouched.current = true;
                setModel({
                  provider,
                  modelId,
                  thinkingLevel: info?.thinkingLevel,
                  thinkingLevels: info?.thinkingLevels,
                });
              }}
              thinkingLevel={model?.thinkingLevel}
              thinkingLevels={model?.thinkingLevels}
              onThinkingLevelChange={changeThinkingLevel}
              submitLabel={busy
                ? t("chat.newSession.submitCreating")
                : t("chat.newSession.submitStart")}
              submitIcon={IconArrowUp}
              submitIconOnly
              submitDisabled={busy || noModelToStart ||
                (!input.trim() && images.length === 0) ||
                !selectedWorkspace}
              onSubmit={() => void submit()}
              onOpenSettings={onOpenSettings}
              mentionWorkspaceId={selectedWorkspace === undefined ||
                  selectedWorkspace.chat
                ? undefined
                : selectedWorkspace.id}
              slashCommands={allSlashCommands.length > 0
                ? allSlashCommands
                : undefined}
              onSlashCommand={handleSlashCommand}
              images={images}
              onImagesChange={onImagesChange}
            />
            {error && <div className="error-text">{error}</div>}
            <div className="new-session-recent">
              <div className="new-session-recent-header">
                <h3>{t("chat.newSession.recentTitle")}</h3>
              </div>
              <RecentSessionsList
                items={recent.items}
                loading={recent.loading}
                error={recent.error}
                openKeys={NO_OPEN_SESSIONS}
                limit={8}
                bare
                onSelect={onReopenSession}
                onReload={recent.reload}
              />
            </div>
          </div>
        </div>
      </div>
      {showWorkspaceModal && (
        <WorkspaceModal
          workspace={modalWorkspace}
          onSaved={(ws) => {
            onWorkspaceChanged(ws);
            setWorkspaceId(ws.id);
            setShowWorkspaceModal(false);
          }}
          onDelete={deleteWorkspace}
          onClose={() => setShowWorkspaceModal(false)}
        />
      )}
    </div>
  );
}
