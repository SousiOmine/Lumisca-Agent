import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Workspace } from "../types.ts";
import { Composer, type ComposerModel } from "./Composer.tsx";
import { WorkspaceModal } from "./WorkspaceModal.tsx";

/** Select value meaning "create a new workspace". */
const NEW_WORKSPACE = "__new__";

interface NewSessionViewProps {
  workspaces: Workspace[];
  onStart: (
    workspaceId: string,
    model: ComposerModel | null,
    text: string,
  ) => Promise<void>;
  onWorkspaceCreated: (ws: Workspace) => void;
}

/** The draft session tab: pick workspace/model and start from the center. */
export function NewSessionView(
  { workspaces, onStart, onWorkspaceCreated }: NewSessionViewProps,
) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [model, setModel] = useState<ComposerModel | null>(null);
  const [text, setText] = useState("");
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Show the last used model (the one a session without an explicit model
  // would get) right away instead of leaving the picker to choose on click.
  useEffect(() => {
    api.getDefaultModel()
      .then((m) => {
        if (m) setModel({ provider: m.provider, modelId: m.modelId });
      })
      .catch(() => {});
  }, []);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || !workspaceId || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onStart(workspaceId, model, trimmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
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
              <select
                value={workspaceId}
                onChange={(e) => {
                  if (e.target.value === NEW_WORKSPACE) {
                    setShowWorkspaceModal(true);
                    return;
                  }
                  setWorkspaceId(e.target.value);
                }}
              >
                {workspaces.length === 0 && (
                  <option value="">(ワークスペースがありません)</option>
                )}
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
                <option value={NEW_WORKSPACE}>
                  ＋ 新しいワークスペースを作成
                </option>
              </select>
            </label>
            <Composer
              value={text}
              onChange={setText}
              placeholder="タスクを入力して開始..."
              autoFocus
              large
              model={model}
              onModelSelect={(provider, modelId) =>
                setModel({ provider, modelId })}
              submitLabel={busy ? "作成中..." : "開始"}
              submitDisabled={busy || !text.trim() || !workspaceId}
              onSubmit={submit}
            />
            {error && <div className="error-text">{error}</div>}
          </div>
        </div>
      </div>
      {showWorkspaceModal && (
        <WorkspaceModal
          onCreated={(ws) => {
            onWorkspaceCreated(ws);
            setWorkspaceId(ws.id);
            setShowWorkspaceModal(false);
          }}
          onClose={() => setShowWorkspaceModal(false)}
        />
      )}
    </div>
  );
}
