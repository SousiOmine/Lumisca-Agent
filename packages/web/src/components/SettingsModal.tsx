import { useState } from "react";
import {
  IconChevronRight,
  IconPlugConnected,
  IconServer,
  IconX,
} from "@tabler/icons-react";
import { Modal } from "./Modal.tsx";
import { ProviderList } from "./settings/ProviderList.tsx";
import { AddProviderFlow } from "./settings/AddProviderFlow.tsx";
import { ProviderDetail } from "./settings/ProviderDetail.tsx";
import { McpList } from "./settings/McpList.tsx";

interface SettingsModalProps {
  onClose: () => void;
}

type View =
  | { kind: "home" }
  | { kind: "list" }
  | { kind: "add" }
  | { kind: "detail"; providerId: string; isNew: boolean }
  | { kind: "mcp"; workspaceId: string };

export function SettingsModal({ onClose }: SettingsModalProps) {
  const [view, setView] = useState<View>({ kind: "home" });
  const home = () => setView({ kind: "home" });

  return (
    <Modal width="min(720px, calc(100vw - 48px))" onClose={onClose}>
      {view.kind === "home" && (
        <HomeView
          onOpenProviders={() => setView({ kind: "list" })}
          onOpenMcp={() => setView({ kind: "mcp", workspaceId: "" })}
          onClose={onClose}
        />
      )}
      {view.kind === "list" && (
        <ProviderList
          onBack={home}
          onAdd={() => setView({ kind: "add" })}
          onOpen={(id) =>
            setView({ kind: "detail", providerId: id, isNew: false })}
          onClose={onClose}
        />
      )}
      {view.kind === "add" && (
        <AddProviderFlow
          onSelect={(id) =>
            setView({ kind: "detail", providerId: id, isNew: true })}
          onBack={() => setView({ kind: "list" })}
        />
      )}
      {view.kind === "detail" && (
        <ProviderDetail
          providerId={view.providerId}
          isNew={view.isNew}
          onBack={() => setView({ kind: "list" })}
        />
      )}
      {view.kind === "mcp" && <McpList onBack={home} onClose={onClose} />}
    </Modal>
  );
}

// --- settings home -------------------------------------------------------------

function HomeView({
  onOpenProviders,
  onOpenMcp,
  onClose,
}: {
  onOpenProviders: () => void;
  onOpenMcp: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="modal-header">
        <h2>設定</h2>
        <button type="button" className="btn push" onClick={onClose}>
          <IconX size={14} />
          閉じる
        </button>
      </div>
      <div className="settings-menu">
        <button
          type="button"
          className="settings-menu-item"
          onClick={onOpenProviders}
        >
          <span className="settings-menu-icon">
            <IconPlugConnected size={20} />
          </span>
          <span className="settings-menu-text">
            <span className="settings-menu-title">プロバイダー</span>
            <span className="settings-menu-desc">
              APIキーの登録と、モデルの有効/無効の管理
            </span>
          </span>
          <span className="chevron">
            <IconChevronRight size={16} />
          </span>
        </button>
        <button
          type="button"
          className="settings-menu-item"
          onClick={onOpenMcp}
        >
          <span className="settings-menu-icon">
            <IconServer size={20} />
          </span>
          <span className="settings-menu-text">
            <span className="settings-menu-title">MCP サーバー</span>
            <span className="settings-menu-desc">
              外部ツールサーバーの追加・編集 (.mcp.json)
            </span>
          </span>
          <span className="chevron">
            <IconChevronRight size={16} />
          </span>
        </button>
      </div>
    </>
  );
}
