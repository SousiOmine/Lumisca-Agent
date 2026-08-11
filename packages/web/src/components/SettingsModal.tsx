import { useState } from "react";
import type { ReactNode } from "react";
import {
  IconBrain,
  IconPalette,
  IconPlugConnected,
  IconServer,
  IconSettings,
  IconUser,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import { Modal } from "./Modal.tsx";
import { ProviderList } from "./settings/ProviderList.tsx";
import { AddProviderFlow } from "./settings/AddProviderFlow.tsx";
import { ProviderDetail } from "./settings/ProviderDetail.tsx";
import { ModelList } from "./settings/ModelList.tsx";
import { ModelPreferencePanel } from "./settings/ModelPreferencePanel.tsx";
import { McpList } from "./settings/McpList.tsx";
import { ConnectionList } from "./settings/ConnectionList.tsx";
import { PersonalizePanel } from "./settings/PersonalizePanel.tsx";
import { AppearancePanel } from "./settings/AppearancePanel.tsx";
import { GeneralPanel } from "./settings/GeneralPanel.tsx";
import type { UpdateControls } from "../hooks/useUpdateStatus.ts";
import type { ThemeSetting } from "../types.ts";

interface SettingsModalProps {
  theme: ThemeSetting;
  onThemeChange: (theme: ThemeSetting) => void;
  update: UpdateControls;
  onClose: () => void;
}

type Category =
  | "general"
  | "providers"
  | "models"
  | "mcp"
  | "servers"
  | "personalize"
  | "appearance";

type ProvidersView =
  | { kind: "list" }
  | { kind: "add" }
  | { kind: "detail"; providerId: string };

const CATEGORIES: {
  id: Category;
  label: string;
  icon: ReactNode;
}[] = [
  {
    id: "general",
    label: "一般",
    icon: <IconSettings size={18} />,
  },
  {
    id: "appearance",
    label: "外観",
    icon: <IconPalette size={18} />,
  },
  {
    id: "personalize",
    label: "パーソナライズ",
    icon: <IconUser size={18} />,
  },
  { id: "servers", label: "接続先サーバー", icon: <IconWorld size={18} /> },
  {
    id: "providers",
    label: "プロバイダー",
    icon: <IconPlugConnected size={18} />,
  },
  {
    id: "models",
    label: "モデル",
    icon: <IconBrain size={18} />,
  },
  { id: "mcp", label: "MCP サーバー", icon: <IconServer size={18} /> },
];

export function SettingsModal({
  theme,
  onThemeChange,
  update,
  onClose,
}: SettingsModalProps) {
  const [category, setCategory] = useState<Category>("general");
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
          {category === "general" && (
            <GeneralPanel
              status={update.status}
              onSetAuto={update.setAuto}
              onCheck={update.check}
              onDownload={update.download}
              onInstall={update.install}
            />
          )}
          {category === "providers" && providersView.kind === "list" && (
            <ProviderList
              onAdd={() => setProvidersView({ kind: "add" })}
              onOpen={(id) =>
                setProvidersView({ kind: "detail", providerId: id })}
            />
          )}
          {category === "providers" && providersView.kind === "add" && (
            <AddProviderFlow
              onSelect={(id) =>
                setProvidersView({ kind: "detail", providerId: id })}
              onBack={() => setProvidersView({ kind: "list" })}
            />
          )}
          {category === "providers" && providersView.kind === "detail" && (
            <ProviderDetail
              providerId={providersView.providerId}
              onBack={() => setProvidersView({ kind: "list" })}
            />
          )}
          {category === "models" && (
            <>
              <ModelPreferencePanel />
              <ModelList />
            </>
          )}
          {category === "mcp" && <McpList />}
          {category === "servers" && <ConnectionList />}
          {category === "personalize" && <PersonalizePanel />}
          {category === "appearance" && (
            <AppearancePanel
              theme={theme}
              onThemeChange={onThemeChange}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
