import { useEffect, useMemo, useRef, useState } from "react";
import { IconArrowUp, IconMessage } from "@tabler/icons-react";
import { api } from "../api.ts";
import type {
  FederatedWorkspace,
  ModelInfo,
  ModePrompt,
  PeerStatus,
  PendingImage,
  SavedPrompt,
  ThinkingLevel,
} from "../types.ts";
import { errorText, setModelThinkingLevel } from "../providers.ts";
import { splitTabKey, tabKey } from "../tabs.ts";
import {
  slashCommands,
  slashPrompt,
  slashPromptFromText,
} from "../slashCommands.ts";
import {
  Composer,
  type ComposerModel,
  type SlashCommand,
  type SlashCommandItem,
} from "./Composer.tsx";
import { PeerPicker } from "./PeerPicker.tsx";
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
  workspaces: FederatedWorkspace[];
  /** Whether the workspace list has arrived (initial data counts as
   * loaded; a failed load counts too). While false a restored workspace
   * key is kept as-is and re-validated once the list lands. */
  workspacesLoaded: boolean;
  /** Peers that did not answer the workspace list fetch. */
  peers: PeerStatus[];
  /** Draft (unsent) composer content, owned by the App under the draft
   * tab key so it survives switching away and back. */
  input: string;
  onInputChange: (value: string) => void;
  images: PendingImage[];
  onImagesChange: (images: PendingImage[]) => void;
  onStart: (
    fws: FederatedWorkspace,
    model: ComposerModel | null,
    text: string,
    images: PendingImage[],
    /** Set when the first prompt is a mode prompt (e.g. plan mode): the
     * session starts with a ModeMessage (short text + badge) instead of
     * a plain user message. */
    mode?: ModePrompt,
  ) => Promise<void>;
  onWorkspaceChanged: (fws: FederatedWorkspace) => void;
  /** The single delete flow owned by the App (confirm + API + state). */
  onDeleteWorkspace: (fws: FederatedWorkspace) => Promise<void>;
  /** Reopen a closed session in a tab (recent sessions list). */
  onReopenSession: (key: string) => void;
  onOpenSettings?: () => void;
}

/** Sentinel workspace id of the pinned chat entry: selecting it starts a
 * chat session without a workspace (the server creates its own chat
 * workspace). Never a real row; excluded from the regular picker list. */
const CHAT_ENTRY_ID = "@chat";

function chatEntry(peerId: string): FederatedWorkspace {
  return {
    peerId,
    peerName: "",
    workspace: {
      id: CHAT_ENTRY_ID,
      name: "チャット",
      folders: [],
      createdAt: 0,
      chat: true,
    },
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
 * Workspaces from every federated server appear here; picking one on
 * another machine runs the agent there (peer default model). */
export function NewSessionView(
  {
    workspaces,
    workspacesLoaded,
    peers,
    input,
    onInputChange,
    images,
    onImagesChange,
    onStart,
    onWorkspaceChanged,
    onDeleteWorkspace,
    onReopenSession,
    onOpenSettings,
  }: NewSessionViewProps,
) {
  // The last selected workspace, restored from localStorage. Kept in a ref
  // until the (possibly async) workspace list can validate it.
  const pendingWorkspaceKey = useRef<string | null>(loadLastWorkspaceKey());
  const [selectedPeerId, setSelectedPeerId] = useState(
    () => splitTabKey(pendingWorkspaceKey.current ?? "").peerId,
  );
  const [workspaceKey, setWorkspaceKey] = useState(
    pendingWorkspaceKey.current ?? "",
  );
  const [model, setModel] = useState<DraftModel | null>(null);
  const [modalWorkspace, setModalWorkspace] = useState<
    FederatedWorkspace | undefined
  >(undefined);
  const [modalPeerId, setModalPeerId] = useState("");
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const modelTouched = useRef(false);
  const recent = useRecentSessions();

  // --- saved prompts ------------------------------------------------------

  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);

  useEffect(() => {
    let stale = false;
    api.getSavedPrompts()
      .then((result) => {
        if (stale) return;
        setSavedPrompts(result.prompts);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  // Show the last used model (the one a session without an explicit model
  // would get) right away instead of leaving the picker to choose on click.
  // A selection the user already made is never overwritten by the late
  // response.
  useEffect(() => {
    let stale = false;
    api.getDefaultModel()
      .then((m) => {
        if (stale) return;
        if (m && !modelTouched.current) {
          setModel({
            provider: m.provider,
            modelId: m.modelId,
            thinkingLevel: m.thinkingLevel,
            thinkingLevels: m.thinkingLevels,
          });
        }
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  // Filter workspaces by the selected peer. The pinned chat entry ("simple
  // chat" without a workspace) is a synthetic selection available for every
  // peer. The server already hides chat workspaces from the list API; the
  // flag filter here is defensive (e.g. against an older server), since
  // chat rows are never user-manageable.
  const filteredWorkspaces = workspaces.filter(
    (w) => w.peerId === selectedPeerId,
  );
  const pickerWorkspaces = filteredWorkspaces.filter(
    (w) => !w.workspace.chat,
  );
  // A peer is selectable when it is the local server ("") or it appears in
  // the peer list (registered connections; unreachable but registered is
  // still a real machine) or owns a workspace in the fetched list. A
  // restored peer outside this set is a deleted connection: the chat entry
  // for it is synthetic and must not make the restored key look valid.
  const selectablePeer = (peerId: string): boolean =>
    peerId === "" ||
    peers.some((p) => p.id === peerId) ||
    workspaces.some((w) => w.peerId === peerId);
  const chatOption = selectablePeer(selectedPeerId)
    ? chatEntry(selectedPeerId)
    : undefined;

  // Keep a valid selection when the workspace list changes (e.g. after a
  // delete); fall back to the chat entry when nothing else remains. A
  // restored key (localStorage) is applied once the list has arrived: the
  // key is kept verbatim while the list is still loading — empty arrays
  // and "not loaded yet" are indistinguishable by length alone, so the
  // explicit `workspacesLoaded` flag gates the validation. After the list
  // lands (even with zero workspaces), an invalid restored key falls back
  // to the first selectable option (the chat entry), never leaving the
  // draft screen stuck on an unselectable workspace.
  useEffect(() => {
    // A restored peer that no longer exists (deleted connection) is
    // invalid once the list arrives: revert the selection to the local
    // server. The workspace key below then falls back with it — the
    // synthetic chat entry would otherwise keep the restored key valid
    // and every start would fail on the deleted peer.
    if (workspacesLoaded && !selectablePeer(selectedPeerId)) {
      setSelectedPeerId("");
      return;
    }
    const selectable = [
      ...(chatOption ? [chatOption] : []),
      ...pickerWorkspaces,
    ];
    const fallback = selectable[0]
      ? tabKey(selectable[0].peerId, selectable[0].workspace.id)
      : "";
    setWorkspaceKey((current) => {
      const pending = pendingWorkspaceKey.current;
      if (pending !== null) {
        pendingWorkspaceKey.current = null;
        if (!workspacesLoaded) return pending;
        return selectable.some(
            (w) => tabKey(w.peerId, w.workspace.id) === pending,
          )
          ? pending
          : fallback;
      }
      return selectable.some(
          (w) => tabKey(w.peerId, w.workspace.id) === current,
        )
        ? current
        : fallback;
    });
  }, [workspaces, workspacesLoaded, selectedPeerId, peers]);

  // Reset workspace selection when the peer changes. Skipped on the first
  // run so a restored peer (from the last workspace) is not overwritten.
  const peerChanged = useRef(false);
  useEffect(() => {
    if (!peerChanged.current) {
      peerChanged.current = true;
      return;
    }
    const selectable = [
      ...(chatOption ? [chatOption] : []),
      ...pickerWorkspaces,
    ];
    setWorkspaceKey(
      selectable[0]
        ? tabKey(
          selectable[0].peerId,
          selectable[0].workspace.id,
        )
        : "",
    );
  }, [selectedPeerId]);

  // Remember the last selected workspace so it can be restored on the next
  // visit to the new session screen (after a restart or tab switch).
  useEffect(() => {
    try {
      if (workspaceKey) {
        localStorage.setItem(LAST_WORKSPACE_KEY, workspaceKey);
      } else {
        localStorage.removeItem(LAST_WORKSPACE_KEY);
      }
    } catch {
      // ignore storage failures
    }
  }, [workspaceKey]);

  const selectedWorkspace = [
    ...(chatOption ? [chatOption] : []),
    ...pickerWorkspaces,
  ].find(
    (w) => tabKey(w.peerId, w.workspace.id) === workspaceKey,
  );
  // Sessions on another server are created with that server's default
  // model, so the model picker is hidden for them.
  const remoteWorkspace = (selectedWorkspace?.peerId ?? "") !== "";

  // Build the slash commands list including the /prompt submenu.
  // In chat mode only saved prompts are shown (agent modes need a workspace).
  const isChat = selectedWorkspace?.workspace.chat ?? false;
  const allSlashCommands = useMemo<SlashCommand[]>(() => {
    const promptItems: SlashCommandItem[] = savedPrompts.map((p) => ({
      id: p.id,
      label: p.label,
      description: p.prompt.slice(0, 80) + (p.prompt.length > 80 ? "..." : ""),
    }));
    if (isChat) {
      // Chat mode: only saved prompts, no agent modes.
      if (promptItems.length === 0) return [];
      return [{
        id: "prompt",
        label: "保存済みプロンプト",
        description: "登録済みのプロンプトを挿入",
        icon: IconMessage,
        items: promptItems,
      }];
    }
    // Workspace mode: agent modes + saved prompts.
    const commands = [...slashCommands];
    if (promptItems.length > 0) {
      commands.push({
        id: "prompt",
        label: "保存済みプロンプト",
        description: "登録済みのプロンプトを挿入",
        icon: IconMessage,
        items: promptItems,
      });
    }
    return commands;
  }, [isChat, savedPrompts]);

  /** Start the session with the composer text, or an explicit message (slash
   * commands build their own prompt). The draft is cleared by the App once
   * the session started; on failure it stays so the user can retry.
   * `mode` marks the message as a mode prompt (ModeMessage in the
   * transcript). Composer text that starts with a text-taking command line
   * (`/plan 依頼文`) is wrapped into that mode's prompt even when the
   * slash menu was bypassed (send button, Ctrl+Enter); without the request
   * text nothing is sent. */
  const submit = async (message?: string, mode?: ModePrompt) => {
    let trimmed = (message ?? input).trim();
    if (
      (!trimmed && images.length === 0) ||
      !workspaceKey || !selectedWorkspace || busy
    ) {
      return;
    }
    if (message === undefined && !isChat) {
      const line = slashPromptFromText(trimmed);
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

  /** A slash command was chosen. Agent modes (existing commands) build
   * their prompt and start the session; the /prompt submenu inserts the
   * saved prompt text into the composer so the user can edit and send it.
   * `text` is the composer text after the command token (empty for a bare
   * `/command`); text-taking modes (e.g. plan) wrap it as their subject
   * and are not sent while it is missing. */
  const handleSlashCommand = (
    command: SlashCommand,
    item?: SlashCommandItem,
    text?: string,
  ) => {
    if (command.id === "prompt" && item) {
      const saved = savedPrompts.find((p) => p.id === item.id);
      if (saved) {
        onInputChange(saved.prompt);
      }
      return;
    }
    const result = slashPrompt(command, item, text);
    if (result !== null) void submit(result.text, result.mode);
  };

  const deleteWorkspace = async (fws: FederatedWorkspace) => {
    setError(undefined);
    try {
      await onDeleteWorkspace(fws);
    } catch (e) {
      setError(errorText(e));
    }
  };

  /** Set the thinking level for the draft's model (a per-model setting on
   * this server; the draft is always local). */
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
            <h2>新しいセッション</h2>
            <div className="new-session-select-row">
              <label className="new-session-select">
                <span>ワークスペース</span>
                <WorkspacePicker
                  workspaces={pickerWorkspaces}
                  chat={chatOption}
                  value={workspaceKey}
                  onChange={setWorkspaceKey}
                  onEdit={(fws) => {
                    setModalWorkspace(fws);
                    setModalPeerId(fws.peerId);
                    setShowWorkspaceModal(true);
                  }}
                  onDelete={deleteWorkspace}
                  onCreate={() => {
                    setModalWorkspace(undefined);
                    setModalPeerId(selectedPeerId);
                    setShowWorkspaceModal(true);
                  }}
                />
              </label>
              <label className="new-session-select">
                <span>マシン</span>
                <PeerPicker
                  peers={peers}
                  workspaces={workspaces}
                  value={selectedPeerId}
                  onChange={setSelectedPeerId}
                />
              </label>
            </div>
            <Composer
              value={input}
              onChange={onInputChange}
              placeholder="タスクを入力して開始..."
              autoFocus
              large
              model={model}
              hideModelSwitch={remoteWorkspace}
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
              submitLabel={busy ? "作成中..." : "開始"}
              submitIcon={IconArrowUp}
              submitIconOnly
              submitDisabled={busy || (!input.trim() && images.length === 0) ||
                !workspaceKey}
              onSubmit={() => void submit()}
              onOpenSettings={onOpenSettings}
              mentionWorkspaceId={!selectedWorkspace?.workspace.chat
                ? selectedWorkspace?.workspace.id
                : undefined}
              mentionPeerId={selectedWorkspace?.peerId}
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
                <h3>最近のセッション</h3>
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
          workspace={modalWorkspace?.workspace}
          peerId={modalPeerId}
          peerName={modalWorkspace?.peerName ??
            peers.find((p) => p.id === modalPeerId)?.name ??
            modalPeerId}
          onSaved={(ws) => {
            const fws = {
              peerId: modalPeerId,
              peerName: modalWorkspace?.peerName ?? "",
              workspace: ws,
            };
            onWorkspaceChanged(fws);
            setWorkspaceKey(tabKey(modalPeerId, ws.id));
            setShowWorkspaceModal(false);
          }}
          onDelete={deleteWorkspace}
          onClose={() => setShowWorkspaceModal(false)}
        />
      )}
    </div>
  );
}
