import { useState } from "preact/compat";
import type { ReactNode } from "preact/compat";
import {
  IconBrain,
  IconPalette,
  IconPlugConnected,
  IconServer,
  IconSettings,
  IconShield,
  IconUser,
  IconWorld,
  IconX,
} from "@tabler/icons-preact";
import type { MessageKey } from "@lumisca/core/shared";
import { useT } from "../i18n.ts";
import { Modal } from "./Modal.tsx";
import { ProviderList } from "./settings/ProviderList.tsx";
import { AddProviderFlow } from "./settings/AddProviderFlow.tsx";
import { ProviderDetail } from "./settings/ProviderDetail.tsx";
import { AddUserProviderForm } from "./settings/AddUserProviderForm.tsx";
import { reloadCatalog, useUserProviders } from "../providers.ts";
import type { UserProviderSummary } from "../types.ts";
import { ModelList } from "./settings/ModelList.tsx";
import { ModelPreferencePanel } from "./settings/ModelPreferencePanel.tsx";
import { CompactionSettings } from "./settings/CompactionSettings.tsx";
import { McpList } from "./settings/McpList.tsx";
import { ConnectionList } from "./settings/ConnectionList.tsx";
import { PersonalizePanel } from "./settings/PersonalizePanel.tsx";
import { AppearancePanel } from "./settings/AppearancePanel.tsx";
import { CommandSafetyPanel } from "./settings/CommandSafetyPanel.tsx";
import { GeneralPanel } from "./settings/GeneralPanel.tsx";
import type { UpdateControls } from "../hooks/useUpdateStatus.ts";
import type { Locale, ThemeSetting } from "../types.ts";

interface SettingsModalProps {
  theme: ThemeSetting;
  /** Persist failure of the theme setting (shown in the appearance panel). */
  themeError: string | null;
  onThemeChange: (theme: ThemeSetting) => void;
  /** The app language and the persist failure of the last change (shown in
   * the general panel). */
  language: Locale;
  languageError: string | null;
  onLanguageChange: (language: Locale) => void;
  update: UpdateControls;
  /** Background agent-event notifications (desktop only). */
  notifyEnabled: boolean;
  onNotifyEnabledChange: (enabled: boolean) => void;
  /** Category selected when the modal opens (the model picker opens it
   * with "providers"). */
  initialCategory: SettingsCategory;
  onClose: () => void;
}

export type SettingsCategory =
  | "general"
  | "appearance"
  | "providers"
  | "models"
  | "mcp"
  | "servers"
  | "personalize"
  | "security";

/** Provider category navigation. `detail` records which screen it was
 * opened from so "戻る" returns there instead of always to the list. */
type ProvidersView =
  | { kind: "list" }
  | { kind: "add" }
  | { kind: "detail"; providerId: string; from: "list" | "add" }
  | { kind: "addUser" }
  | { kind: "editUser"; providerId: string };

/** Navigation entries. The labels are catalogue keys: they follow the app
 * language like every other string. */
const CATEGORIES: {
  id: SettingsCategory;
  labelKey: MessageKey;
  icon: ReactNode;
}[] = [
  {
    id: "general",
    labelKey: "settings.nav.general",
    icon: <IconSettings size={18} />,
  },
  {
    id: "appearance",
    labelKey: "settings.nav.appearance",
    icon: <IconPalette size={18} />,
  },
  {
    id: "personalize",
    labelKey: "settings.nav.personalize",
    icon: <IconUser size={18} />,
  },
  {
    id: "servers",
    labelKey: "settings.nav.servers",
    icon: <IconWorld size={18} />,
  },
  {
    id: "providers",
    labelKey: "settings.nav.providers",
    icon: <IconPlugConnected size={18} />,
  },
  {
    id: "models",
    labelKey: "settings.nav.models",
    icon: <IconBrain size={18} />,
  },
  { id: "mcp", labelKey: "settings.nav.mcp", icon: <IconServer size={18} /> },
  {
    id: "security",
    labelKey: "settings.nav.security",
    icon: <IconShield size={18} />,
  },
];

export function SettingsModal({
  theme,
  themeError,
  onThemeChange,
  language,
  languageError,
  onLanguageChange,
  update,
  notifyEnabled,
  onNotifyEnabledChange,
  initialCategory,
  onClose,
}: SettingsModalProps) {
  const t = useT();
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const [providersView, setProvidersView] = useState<ProvidersView>({
    kind: "list",
  });
  const userProviders = useUserProviders();

  const userProviderForEdit = (id: string): UserProviderSummary | undefined =>
    userProviders.providers.find((p) => p.id === id);

  const openCategory = (id: SettingsCategory) => {
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
        <h2>{t("settings.dialog.title")}</h2>
        <button
          type="button"
          className="btn push"
          onClick={onClose}
          title={t("common.close")}
          aria-label={t("common.close")}
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
              {t(c.labelKey)}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {category === "general" && (
            <GeneralPanel
              status={update.status}
              source={update.source}
              bridgeError={update.error}
              language={language}
              languageError={languageError}
              onLanguageChange={onLanguageChange}
              onSetAuto={update.setAuto}
              onSetAutoRestart={update.setAutoRestart}
              onCheck={update.check}
              onDownload={update.download}
              onInstall={update.install}
              onRestart={update.restart}
              notifyEnabled={notifyEnabled}
              onNotifyEnabledChange={onNotifyEnabledChange}
            />
          )}
          {category === "providers" && providersView.kind === "list" && (
            <ProviderList
              onAdd={() => setProvidersView({ kind: "add" })}
              onOpen={(id) => {
                if (userProviders.ids.has(id)) {
                  setProvidersView({ kind: "editUser", providerId: id });
                } else {
                  setProvidersView({
                    kind: "detail",
                    providerId: id,
                    from: "list",
                  });
                }
              }}
            />
          )}
          {category === "providers" && providersView.kind === "add" && (
            <AddProviderFlow
              onSelect={(id) =>
                setProvidersView({
                  kind: "detail",
                  providerId: id,
                  from: "add",
                })}
              onAddUser={() => setProvidersView({ kind: "addUser" })}
              onBack={() => setProvidersView({ kind: "list" })}
            />
          )}
          {category === "providers" && providersView.kind === "detail" && (
            <ProviderDetail
              providerId={providersView.providerId}
              onBack={() => setProvidersView({ kind: providersView.from })}
              onDone={() => setProvidersView({ kind: "list" })}
              onEditUser={(providerId) =>
                setProvidersView({ kind: "editUser", providerId })}
            />
          )}
          {category === "providers" && providersView.kind === "addUser" && (
            <AddUserProviderForm
              mode="create"
              onBack={() => setProvidersView({ kind: "list" })}
              onDone={() => {
                userProviders.reload();
                // The new provider must become pickable (and its sessions
                // sendable) without a page reload: the catalog store is
                // what every picker and the composer's send gate read.
                reloadCatalog();
                setProvidersView({ kind: "list" });
              }}
            />
          )}
          {category === "providers" && providersView.kind === "editUser" && (
            <AddUserProviderForm
              mode="edit"
              key={providersView.providerId}
              initial={userProviderForEdit(providersView.providerId)}
              onBack={() => setProvidersView({ kind: "list" })}
              onDone={() => {
                userProviders.reload();
                // An edited provider (a cleared key, a changed base URL)
                // changes whether its models can run: refresh the store.
                reloadCatalog();
                setProvidersView({ kind: "list" });
              }}
              onDeleted={() => {
                userProviders.reload();
                reloadCatalog();
              }}
            />
          )}
          {category === "models" && (
            <>
              <ModelPreferencePanel
                onOpenProviders={() => openCategory("providers")}
              />
              <CompactionSettings />
              <ModelList />
            </>
          )}
          {category === "mcp" && <McpList />}
          {category === "security" && <CommandSafetyPanel />}
          {category === "servers" && <ConnectionList />}
          {category === "personalize" && <PersonalizePanel />}
          {category === "appearance" && (
            <AppearancePanel
              theme={theme}
              error={themeError}
              onThemeChange={onThemeChange}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
