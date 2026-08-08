import { useEffect, useRef, useState } from "react";
import { IconPlayerPlay } from "@tabler/icons-react";
import { api } from "../api.ts";
import type { ModelInfo, ThinkingLevel, Workspace } from "../types.ts";
import { errorText } from "../providers.ts";
import { Composer, type ComposerModel } from "./Composer.tsx";
import { WorkspaceModal } from "./WorkspaceModal.tsx";
import { WorkspacePicker } from "./WorkspacePicker.tsx";

/** The model plus the thinking levels it supports, so the draft tab's
 * thinking control can render without an extra fetch. */
interface DraftModel extends ComposerModel {
  thinkingLevel?: ThinkingLevel;
  thinkingLevels?: ThinkingLevel[];
}

interface NewSessionViewProps {
  workspaces: Workspace[];
  onStart: (
    workspaceId: string,
    model: ComposerModel | null,
    text: string,
  ) => Promise<void>;
  onWorkspaceChanged: (ws: Workspace) => void;
  /** The single delete flow owned by the App (confirm + API + state). */
  onDeleteWorkspace: (ws: Workspace) => Promise<void>;
}

/** The draft session tab: pick workspace/model and start from the center. */
export function NewSessionView(
  {
    workspaces,
    onStart,
    onWorkspaceChanged,
    onDeleteWorkspace,
  }: NewSessionViewProps,
) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [model, setModel] = useState<DraftModel | null>(null);
  const [text, setText] = useState("");
  const [modalWorkspace, setModalWorkspace] = useState<Workspace | undefined>(
    undefined,
  );
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

  // Keep a valid selection when the workspace list changes (e.g. after a
  // delete); fall back to the first remaining workspace.
  useEffect(() => {
    setWorkspaceId((current) =>
      workspaces.some((w) => w.id === current)
        ? current
        : (workspaces[0]?.id ?? "")
    );
  }, [workspaces]);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || !workspaceId || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onStart(workspaceId, model, trimmed);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const deleteWorkspace = async (ws: Workspace) => {
    setError(undefined);
    try {
      await onDeleteWorkspace(ws);
    } catch (e) {
      setError(errorText(e));
    }
  };

  /** Set the thinking level for the draft's model (a per-model setting). */
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
            <label className="new-session-select">
              <span>ワークスペース</span>
              <WorkspacePicker
                workspaces={workspaces}
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
            <Composer
              value={text}
              onChange={setText}
              placeholder="タスクを入力して開始..."
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
              submitLabel={busy ? "作成中..." : "開始"}
              submitIcon={busy ? undefined : IconPlayerPlay}
              submitDisabled={busy || !text.trim() || !workspaceId}
              onSubmit={submit}
            />
            {error && <div className="error-text">{error}</div>}
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
