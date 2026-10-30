import { useState } from "preact/compat";
import type { ReactNode } from "preact/compat";
import {
  IconBrain,
  IconPalette,
  IconPlugConnected,
  IconRepeat,
  IconServer,
  IconSettings,
  IconShield,
  IconUser,
  IconWorld,
  IconWorldSearch,
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
import { ModelList } from "./settings/ModelList.tsx";
import { ModelPreferencePanel } from "./settings/ModelPreferencePanel.tsx";
import { CompactionSettings } from "./settings/CompactionSettings.tsx";
import { McpList } from "./settings/McpList.tsx";
import { RoutinePanel } from "./settings/RoutinePanel.tsx";
import type { useRoutines } from "../hooks/useRoutines.ts";
import { ConnectionList } from "./settings/ConnectionList.tsx";
import { PersonalizePanel } from "./settings/PersonalizePanel.tsx";
import { AppearancePanel } from "./settings/AppearancePanel.tsx";
import { CommandSafetyPanel } from "./settings/CommandSafetyPanel.tsx";
import { ComputerUsePanel } from "./settings/ComputerUsePanel.tsx";
import { WebSearchPanel } from "./settings/WebSearchPanel.tsx";
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
  /** The routines of the active stella agent (empty in code mode, which has
   * no agent), plus which agent they belong to. */
  routines: ReturnType<typeof useRoutines>;
  routineAgent: string | null;
  onClose: () => void;
}

/** What each panel needs. One object instead of a prop per panel: the
 * table below renders them, so the wiring lives next to the entry that uses
 * it. */
interface PanelContext {
  props: SettingsModalProps;
  /** Switch to another category (a panel's "open the provider settings"
   * link reaches across). */
  openCategory: (id: SettingsCategory) => void;
  /** The panel's own navigation state (providers has sub-screens). */
  providersView: ProvidersView;
  setProvidersView: (view: ProvidersView) => void;
  userProviders: ReturnType<typeof useUserProviders>;
  reloadCatalog: () => void;
}

interface SettingsCategoryEntry {
  id: SettingsCategory;
  labelKey: MessageKey;
  icon: ReactNode;
  /** The screen this category shows. */
  render: (panels: PanelContext) => ReactNode;
}

export type SettingsCategory =
  | "general"
  | "appearance"
  | "providers"
  | "models"
  | "mcp"
  | "webSearch"
  | "routines"
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
 * language like every other string.
 *
 * Each entry also carries its panel: navigation and body used to be two
 * separate lists (a `SettingsCategory` union, this array, and an eleven-branch
 * `category === "…" && <Panel/>` ladder), so adding a category meant editing
 * three places and a forgotten one was not a type error. One table cannot
 * drift from itself. */
const CATEGORIES: readonly SettingsCategoryEntry[] = [
  {
    id: "general",
    labelKey: "settings.nav.general",
    icon: <IconSettings size={18} />,
    render: ({ props }) => (
      <GeneralPanel
        status={props.update.status}
        source={props.update.source}
        bridgeError={props.update.error}
        language={props.language}
        languageError={props.languageError}
        onLanguageChange={props.onLanguageChange}
        onSetAuto={props.update.setAuto}
        onSetAutoRestart={props.update.setAutoRestart}
        onCheck={props.update.check}
        onDownload={props.update.download}
        onInstall={props.update.install}
        onRestart={props.update.restart}
        notifyEnabled={props.notifyEnabled}
        onNotifyEnabledChange={props.onNotifyEnabledChange}
      />
    ),
  },
  {
    id: "appearance",
    labelKey: "settings.nav.appearance",
    icon: <IconPalette size={18} />,
    render: ({ props }) => (
      <AppearancePanel
        theme={props.theme}
        error={props.themeError}
        onThemeChange={props.onThemeChange}
      />
    ),
  },
  {
    id: "personalize",
    labelKey: "settings.nav.personalize",
    icon: <IconUser size={18} />,
    render: () => <PersonalizePanel />,
  },
  {
    id: "servers",
    labelKey: "settings.nav.servers",
    icon: <IconWorld size={18} />,
    render: () => <ConnectionList />,
  },
  {
    id: "providers",
    labelKey: "settings.nav.providers",
    icon: <IconPlugConnected size={18} />,
    render: ({ providersView, setProvidersView, userProviders }) => {
      switch (providersView.kind) {
        case "list":
          return (
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
          );
        case "add":
          return (
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
          );
        case "detail":
          return (
            <ProviderDetail
              providerId={providersView.providerId}
              onBack={() => setProvidersView({ kind: providersView.from })}
              onDone={() => setProvidersView({ kind: "list" })}
              onEditUser={(providerId) =>
                setProvidersView({ kind: "editUser", providerId })}
            />
          );
        case "addUser":
          return (
            <AddUserProviderForm
              mode="create"
              onBack={() => setProvidersView({ kind: "list" })}
              onDone={() => {
                userProviders.reload();
                // The new provider must become pickable (and its sessions
                // sendable) without a page reload: the catalog store is what
                // every picker and the composer's send gate read.
                reloadCatalog();
                setProvidersView({ kind: "list" });
              }}
            />
          );
        case "editUser": {
          const initial = userProviders.providers.find(
            (p) => p.id === providersView.providerId,
          );
          return (
            <AddUserProviderForm
              mode="edit"
              key={providersView.providerId}
              initial={initial}
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
          );
        }
      }
    },
  },
  {
    id: "models",
    labelKey: "settings.nav.models",
    icon: <IconBrain size={18} />,
    render: ({ openCategory }) => (
      <>
        <ModelPreferencePanel
          onOpenProviders={() => openCategory("providers")}
        />
        <CompactionSettings />
        <ModelList />
      </>
    ),
  },
  {
    id: "mcp",
    labelKey: "settings.nav.mcp",
    icon: <IconServer size={18} />,
    render: () => <McpList />,
  },
  {
    id: "webSearch",
    labelKey: "settings.nav.webSearch",
    icon: <IconWorldSearch size={18} />,
    render: () => <WebSearchPanel />,
  },
  {
    id: "routines",
    labelKey: "settings.nav.routines",
    icon: <IconRepeat size={18} />,
    render: ({ props }) => (
      <RoutinePanel
        routines={props.routines.routines}
        loading={props.routines.loading}
        error={props.routines.error}
        agentName={props.routineAgent}
        onRefresh={props.routines.refresh}
        onSetEnabled={props.routines.setEnabled}
        onRun={props.routines.run}
        onStop={props.routines.stop}
        onDelete={props.routines.remove}
      />
    ),
  },
  {
    id: "security",
    labelKey: "settings.nav.security",
    icon: <IconShield size={18} />,
    render: () => (
      <>
        <CommandSafetyPanel />
        <ComputerUsePanel />
      </>
    ),
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
  routines,
  routineAgent,
  onClose,
}: SettingsModalProps) {
  const t = useT();
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const [providersView, setProvidersView] = useState<ProvidersView>({
    kind: "list",
  });
  const userProviders = useUserProviders();

  const openCategory = (id: SettingsCategory) => {
    setCategory(id);
    setProvidersView({ kind: "list" });
  };

  const panels: PanelContext = {
    openCategory,
    // The remaining props are the same object the modal received; the
    // panels read what they need from it.
    props: {
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
      routines,
      routineAgent,
      onClose,
    },
    providersView,
    setProvidersView,
    userProviders,
    reloadCatalog,
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
          {CATEGORIES.find((c) => c.id === category)?.render(panels)}
        </div>
      </div>
    </Modal>
  );
}
