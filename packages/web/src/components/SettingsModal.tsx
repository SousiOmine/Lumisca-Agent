import { useState } from "react";
import type { ReactNode } from "react";
import {
  IconPlugConnected,
  IconServer,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import { Modal } from "./Modal.tsx";
import { ProviderList } from "./settings/ProviderList.tsx";
import { AddProviderFlow } from "./settings/AddProviderFlow.tsx";
import { ProviderDetail } from "./settings/ProviderDetail.tsx";
import { McpList } from "./settings/McpList.tsx";
import { ConnectionList } from "./settings/ConnectionList.tsx";

interface SettingsModalProps {
  onClose: () => void;
}

type Category = "providers" | "mcp" | "servers";

type ProvidersView =
  | { kind: "list" }
  | { kind: "add" }
  | { kind: "detail"; providerId: string; isNew: boolean };

const CATEGORIES: {
  id: Category;
  label: string;
  icon: ReactNode;
}[] = [
  {
    id: "providers",
    label: "プロバイダー",
    icon: <IconPlugConnected size={18} />,
  },
  { id: "mcp", label: "MCP サーバー", icon: <IconServer size={18} /> },
  { id: "servers", label: "接続先サーバー", icon: <IconWorld size={18} /> },
];

export function SettingsModal({ onClose }: SettingsModalProps) {
  const [category, setCategory] = useState<Category>("providers");
  const [providersView, setProvidersView] = useState<ProvidersView>({
    kind: "list",
  });

  const openCategory = (id: Category) => {
    setCategory(id);
    setProvidersView({ kind: "list" });
  };

  return (
    <Modal
      width="min(900px, calc(100vw - 48px))"
      className="modal-settings"
      onClose={onClose}
    >
      <div className="modal-header">
        <h2>設定</h2>
        <button
          type="button"
          className="btn push"
          onClick={onClose}
          title="閉じる"
          aria-label="閉じる"
        >
          <IconX size={16} />
        </button>
      </div>

      <div className="settings-body">
        <nav className="settings-nav">
          {CATEGORIES.map((c) => (
            <button
              type="button"
              key={c.id}
              className={`settings-nav-item${
                category === c.id ? " active" : ""
              }`}
              onClick={() => openCategory(c.id)}
            >
              {c.icon}
              {c.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {category === "providers" && providersView.kind === "list" && (
            <ProviderList
              onAdd={() => setProvidersView({ kind: "add" })}
              onOpen={(id) =>
                setProvidersView({
                  kind: "detail",
                  providerId: id,
                  isNew: false,
                })}
            />
          )}
          {category === "providers" && providersView.kind === "add" && (
            <AddProviderFlow
              onSelect={(id) =>
                setProvidersView({
                  kind: "detail",
                  providerId: id,
                  isNew: true,
                })}
              onBack={() => setProvidersView({ kind: "list" })}
            />
          )}
          {category === "providers" && providersView.kind === "detail" && (
            <ProviderDetail
              providerId={providersView.providerId}
              isNew={providersView.isNew}
              onBack={() => setProvidersView({ kind: "list" })}
            />
          )}
          {category === "mcp" && <McpList />}
          {category === "servers" && <ConnectionList />}
        </div>
      </div>
    </Modal>
  );
}
