import { useEffect, useRef, useState } from "react";
import { IconArrowUp } from "@tabler/icons-react";
import { api } from "../api.ts";
import type {
  FederatedWorkspace,
  ModelInfo,
  PeerStatus,
  ThinkingLevel,
} from "../types.ts";
import { errorText } from "../providers.ts";
import { tabKey } from "../tabs.ts";
import { Composer, type ComposerModel } from "./Composer.tsx";
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
  ) => Promise<void>;
  onWorkspaceChanged: (fws: FederatedWorkspace) => void;
  /** The single delete flow owned by the App (confirm + API + state). */
  onDeleteWorkspace: (fws: FederatedWorkspace) => Promise<void>;
  onOpenSettings?: () => void;
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
  const [selectedPeerId, setSelectedPeerId] = useState("");
  const [workspaceKey, setWorkspaceKey] = useState("");
  const [model, setModel] = useState<DraftModel | null>(null);
  const [text, setText] = useState("");
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
    api.getDefaultModel()
      .then((m) => {
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
  }, []);

  // Filter workspaces by the selected peer.
  const filteredWorkspaces = workspaces.filter(
    (w) => w.peerId === selectedPeerId,
  );

  // Keep a valid selection when the workspace list changes (e.g. after a
  // delete); fall back to the first remaining workspace.
  useEffect(() => {
    setWorkspaceKey((current) =>
      filteredWorkspaces.some(
          (w) => tabKey(w.peerId, w.workspace.id) === current,
        )
        ? current
        : (filteredWorkspaces[0]
          ? tabKey(
            filteredWorkspaces[0].peerId,
            filteredWorkspaces[0].workspace.id,
          )
          : "")
    );
  }, [workspaces, selectedPeerId]);

  // Reset workspace selection when the peer changes.
  useEffect(() => {
    setWorkspaceKey(
      filteredWorkspaces[0]
        ? tabKey(
          filteredWorkspaces[0].peerId,
          filteredWorkspaces[0].workspace.id,
        )
        : "",
    );
  }, [selectedPeerId]);

  const selectedWorkspace = filteredWorkspaces.find(
    (w) => tabKey(w.peerId, w.workspace.id) === workspaceKey,
  );
  // Sessions on another server are created with that server's default
  // model, so the model picker is hidden for them.
  const remoteWorkspace = (selectedWorkspace?.peerId ?? "") !== "";

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || !workspaceKey || !selectedWorkspace || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onStart(selectedWorkspace, model, trimmed);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
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
              submitDisabled={busy || !text.trim() || !workspaceKey}
              onSubmit={submit}
              onOpenSettings={onOpenSettings}
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
