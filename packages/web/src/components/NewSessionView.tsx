import { useEffect, useRef, useState } from "react";
import { IconArrowUp } from "@tabler/icons-react";
import { api } from "../api.ts";
import type {
  FederatedWorkspace,
  ModelInfo,
  PeerStatus,
  PendingImage,
  ThinkingLevel,
} from "../types.ts";
import { errorText } from "../providers.ts";
import { splitTabKey, tabKey } from "../tabs.ts";
import { slashCommands, slashPrompt } from "../slashCommands.ts";
import {
  Composer,
  type ComposerModel,
  type SlashCommand,
  type SlashCommandItem,
} from "./Composer.tsx";
import { PeerPicker } from "./PeerPicker.tsx";
import { WorkspaceModal } from "./WorkspaceModal.tsx";
import { WorkspacePicker } from "./WorkspacePicker.tsx";

/** The model plus the thinking levels it supports, so the draft tab's
 * thinking control can render without an extra fetch. */
interface DraftModel extends ComposerModel {
  thinkingLevel?: ThinkingLevel;
  thinkingLevels?: ThinkingLevel[];
}

interface NewSessionViewProps {
  workspaces: FederatedWorkspace[];
  /** Peers that did not answer the workspace list fetch. */
  peers: PeerStatus[];
  onStart: (
    fws: FederatedWorkspace,
    model: ComposerModel | null,
    text: string,
    images: PendingImage[],
  ) => Promise<void>;
  onWorkspaceChanged: (fws: FederatedWorkspace) => void;
  /** The single delete flow owned by the App (confirm + API + state). */
  onDeleteWorkspace: (fws: FederatedWorkspace) => Promise<void>;
  onOpenSettings?: () => void;
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
    peers,
    onStart,
    onWorkspaceChanged,
    onDeleteWorkspace,
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
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [modalWorkspace, setModalWorkspace] = useState<
    FederatedWorkspace | undefined
  >(undefined);
  const [modalPeerId, setModalPeerId] = useState("");
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const modelTouched = useRef(false);

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

  // Filter workspaces by the selected peer.
  const filteredWorkspaces = workspaces.filter(
    (w) => w.peerId === selectedPeerId,
  );

  // Keep a valid selection when the workspace list changes (e.g. after a
  // delete); fall back to the first remaining workspace. A restored key is
  // applied once the list arrives and validated against it.
  useEffect(() => {
    setWorkspaceKey((current) => {
      const pending = pendingWorkspaceKey.current;
      if (pending !== null) {
        pendingWorkspaceKey.current = null;
        const valid = filteredWorkspaces.some(
          (w) => tabKey(w.peerId, w.workspace.id) === pending,
        );
        // The list is not loaded yet; keep the restored key.
        if (filteredWorkspaces.length === 0) return pending;
        return valid ? pending : (filteredWorkspaces[0]
          ? tabKey(
            filteredWorkspaces[0].peerId,
            filteredWorkspaces[0].workspace.id,
          )
          : "");
      }
      return filteredWorkspaces.some(
          (w) => tabKey(w.peerId, w.workspace.id) === current,
        )
        ? current
        : (filteredWorkspaces[0]
          ? tabKey(
            filteredWorkspaces[0].peerId,
            filteredWorkspaces[0].workspace.id,
          )
          : "");
    });
  }, [workspaces, selectedPeerId]);

  // Reset workspace selection when the peer changes. Skipped on the first
  // run so a restored peer (from the last workspace) is not overwritten.
  const peerChanged = useRef(false);
  useEffect(() => {
    if (!peerChanged.current) {
      peerChanged.current = true;
      return;
    }
    setWorkspaceKey(
      filteredWorkspaces[0]
        ? tabKey(
          filteredWorkspaces[0].peerId,
          filteredWorkspaces[0].workspace.id,
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

  const selectedWorkspace = filteredWorkspaces.find(
    (w) => tabKey(w.peerId, w.workspace.id) === workspaceKey,
  );
  // Sessions on another server are created with that server's default
  // model, so the model picker is hidden for them.
  const remoteWorkspace = (selectedWorkspace?.peerId ?? "") !== "";

  /** Start the session with the composer text, or an explicit message (slash
   * commands build their own prompt). */
  const submit = async (message?: string) => {
    const trimmed = (message ?? text).trim();
    if (
      (!trimmed && images.length === 0) ||
      !workspaceKey || !selectedWorkspace || busy
    ) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onStart(selectedWorkspace, model, trimmed, images);
      setImages([]);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  /** A slash command (agent mode) was chosen: build its prompt and start
   * the session with it like a regular submit. */
  const handleSlashCommand = (
    command: SlashCommand,
    item?: SlashCommandItem,
  ) => {
    const promptText = slashPrompt(command, item);
    if (promptText !== null) void submit(promptText);
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
      const { thinkingLevel } = await api.setModelThinkingLevel(
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
                  workspaces={filteredWorkspaces}
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
              value={text}
              onChange={setText}
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
              submitDisabled={busy || (!text.trim() && images.length === 0) ||
                !workspaceKey}
              onSubmit={submit}
              onOpenSettings={onOpenSettings}
              mentionWorkspaceId={selectedWorkspace?.workspace.id}
              mentionPeerId={selectedWorkspace?.peerId}
              slashCommands={selectedWorkspace ? slashCommands : undefined}
              onSlashCommand={handleSlashCommand}
              images={images}
              onImagesChange={setImages}
            />
            {error && <div className="error-text">{error}</div>}
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
