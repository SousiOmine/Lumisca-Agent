import { useState } from "preact/compat";
import type { ReactNode } from "preact/compat";
import {
  IconBookmark,
  IconBrain,
  IconPalette,
  IconPlugConnected,
  IconPointer,
  IconRepeat,
  IconServer,
  IconSettings,
  IconShield,
  IconUser,
  IconWorld,
  IconX,
} from "@tabler/icons-preact";
import type { AppMode } from "@lumisca/core/shared";
import { useT } from "../i18n.ts";
import { COMPACT_QUERY, useMediaQuery } from "../hooks/useMediaQuery.ts";
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
import { SavedPromptsPanel } from "./settings/SavedPromptsPanel.tsx";
import { AppearancePanel } from "./settings/AppearancePanel.tsx";
import { CommandSafetyPanel } from "./settings/CommandSafetyPanel.tsx";
import { ComputerUsePanel } from "./settings/ComputerUsePanel.tsx";
import { WebSearchPanel } from "./settings/WebSearchPanel.tsx";
import { GeneralPanel } from "./settings/GeneralPanel.tsx";
import { SettingsPage } from "./settings/SettingsPage.tsx";
import {
  type CommonSettingsCategory,
  modeLabelKey,
  navGroups,
  type SettingsCategory,
  type SettingsNavEntry,
} from "./settings/categories.ts";
import type { UpdateControls } from "../hooks/useUpdateStatus.ts";
import type { Locale, ThemeSetting } from "../types.ts";

export type {
  CommonSettingsCategory,
  SettingsCategory,
} from "./settings/categories.ts";

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
  /** The category the dialog opens on. Only a shared one: the caller does not
   * know which mode this client shows, and a page of the other mode would
   * open empty. */
  initialCategory: CommonSettingsCategory;
  /** The routines of the active stella agent (empty in code mode, which has
   * no agent), plus which agent they belong to. */
  routines: ReturnType<typeof useRoutines>;
  routineAgent: string | null;
  /** The mode this client shows. A category scoped to one mode is listed under
   * that mode's heading, and the header names the mode — the choice is per
   * client, so the dialog says which mode it is describing. */
  mode: AppMode;
  onClose: () => void;
}

/** What each panel needs. One object instead of one prop per panel: the table
 * below renders them, so the wiring lives next to the entry that uses it. */
interface PanelContext {
  props: SettingsModalProps;
  /** Switch to another category (a panel's "open the provider settings" link
   * reaches across). */
  openCategory: (id: CommonSettingsCategory) => void;
  /** The providers category's own navigation state. */
  providersView: ProvidersView;
  setProvidersView: (view: ProvidersView) => void;
  userProviders: ReturnType<typeof useUserProviders>;
}

interface SettingsCategoryEntry extends SettingsNavEntry {
  icon: ReactNode;
  /** The page's body. Its title and description are the entry's labels, and
   * a screen pushed from inside it draws its own bar (SubHeader). */
  render: (panels: PanelContext) => ReactNode;
}

/** Provider category navigation. `detail` records which screen it was opened
 * from, so its back button returns there instead of always to the list. */
type ProvidersView =
  | { kind: "list" }
  | { kind: "add" }
  | { kind: "detail"; providerId: string; from: "list" | "add" }
  | { kind: "addUser" }
  | { kind: "editUser"; providerId: string };

/**
 * The navigation table, in reading order: the shared entries first, then the
 * mode's own.
 *
 * Each entry carries its page: navigation and body used to be two separate
 * lists (a `SettingsCategory` union, this array, and an eleven-branch
 * `category === "…" && <Panel/>` ladder), so adding a category meant editing
 * three places and a forgotten one was not a type error. One table cannot
 * drift from itself.
 *
 * `scope` answers "does this mean anything in the other mode?", and what
 * decides it is what the SERVER does with the value, not what looks related:
 *
 * - `/prompt` is code mode's: only code mode's composers carry the slash menu
 *   (stella's conversation has one box and no commands), so a prompt list
 *   there could never be recalled.
 * - Computer use drives THIS machine's screen; a stella session is given the
 *   virtual machine's own screen tools instead (agent/factory.ts).
 * - Routines schedule a request on a stella agent's conversation, and code
 *   mode has no such conversation.
 */
const CATEGORIES: readonly SettingsCategoryEntry[] = [
  {
    id: "general",
    scope: "common",
    labelKey: "settings.nav.general",
    descriptionKey: "settings.category.general",
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
    scope: "common",
    labelKey: "settings.nav.appearance",
    descriptionKey: "settings.category.appearance",
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
    id: "providers",
    scope: "common",
    labelKey: "settings.nav.providers",
    descriptionKey: "settings.category.providers",
    icon: <IconPlugConnected size={18} />,
    render: ({ providersView, setProvidersView, userProviders }) => {
      switch (providersView.kind) {
        case "list":
          // One category, two providers of one kind: the AI providers whose
          // keys make the agent think, and the search providers whose keys let
          // it look things up. They share a screen because they share a
          // question ("what does this installation talk to, and with which
          // credentials"), and a separate category made the search side easy
          // to miss entirely.
          return (
            <>
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
              <WebSearchPanel />
            </>
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
    scope: "common",
    labelKey: "settings.nav.models",
    descriptionKey: "settings.category.models",
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
    scope: "common",
    labelKey: "settings.nav.mcp",
    descriptionKey: "settings.category.mcp",
    icon: <IconServer size={18} />,
    render: () => <McpList />,
  },
  {
    id: "personalize",
    scope: "common",
    labelKey: "settings.nav.personalize",
    descriptionKey: "settings.category.personalize",
    icon: <IconUser size={18} />,
    render: () => <PersonalizePanel />,
  },
  {
    id: "servers",
    scope: "common",
    labelKey: "settings.nav.servers",
    descriptionKey: "settings.category.servers",
    icon: <IconWorld size={18} />,
    render: () => <ConnectionList />,
  },
  {
    id: "security",
    scope: "common",
    labelKey: "settings.nav.security",
    descriptionKey: "settings.category.security",
    icon: <IconShield size={18} />,
    // The command check guards every bash / eval call, so both modes have it.
    // Computer use is the other half of "what may the agent do", but it is
    // code mode's alone and has its own page: one page never mixes the two
    // scopes, so nothing on it is dead in either mode.
    render: () => <CommandSafetyPanel />,
  },
  {
    id: "computerUse",
    scope: "code",
    labelKey: "settings.nav.computerUse",
    descriptionKey: "settings.category.computerUse",
    icon: <IconPointer size={18} />,
    render: () => <ComputerUsePanel />,
  },
  {
    id: "prompts",
    scope: "code",
    labelKey: "settings.nav.prompts",
    descriptionKey: "settings.category.prompts",
    icon: <IconBookmark size={18} />,
    render: () => <SavedPromptsPanel />,
  },
  {
    id: "routines",
    scope: "stella",
    // The panel's own heading names the category: one wording for one thing,
    // in the navigation and on the page.
    labelKey: "panels.routine.title",
    descriptionKey: "settings.category.routines",
    icon: <IconRepeat size={18} />,
    // Routines schedule requests on a stella agent's conversation; code mode
    // has no such conversation to schedule anything on.
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
];

/**
 * The settings dialog: a navigation of categories on the left, one page on the
 * right.
 *
 * Three decisions shape it.
 *
 * The categories are grouped by what they apply to — the settings both modes
 * share, then the ones only this mode has — so a switch never appears where it
 * does nothing, and the group heading says why it is absent from the other
 * mode. (The dialog knew the same fact before, as a per-category `mode` field,
 * but drew every visible entry in one flat list, where a shared preference and
 * the mode's own were indistinguishable.)
 *
 * A category is a page: its title and one line of explanation stay at the top
 * while the body scrolls (SettingsPage). A long category used to scroll its
 * own title away, and nothing on screen said which category the reader was in.
 *
 * Narrow windows get one screen at a time — the category list, then the picked
 * page with a back button. The horizontal strip of ten labels this replaces
 * clipped every label and had no room for the line that says what a category
 * decides.
 */
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
  mode,
  onClose,
}: SettingsModalProps) {
  const t = useT();
  const stepped = useMediaQuery(COMPACT_QUERY);
  /** In the stepped layout: whether the page (rather than the list) is shown.
   * It starts on the page the dialog was asked for, the same screen every
   * width opens on. */
  const [showPage, setShowPage] = useState(true);
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const [providersView, setProvidersView] = useState<ProvidersView>({
    kind: "list",
  });
  const userProviders = useUserProviders();
  const groups = navGroups(CATEGORIES, mode);
  const entry = CATEGORIES.find((candidate) => candidate.id === category);

  const openCategory = (id: SettingsCategory) => {
    setCategory(id);
    setProvidersView({ kind: "list" });
    setShowPage(true);
  };

  const panels: PanelContext = {
    openCategory,
    // The remaining props are the same object the modal received; the panels
    // read what they need from it.
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
      mode,
      onClose,
    },
    providersView,
    setProvidersView,
    userProviders,
  };

  const modeName = t(modeLabelKey(mode));
  // `list` / `page` are read by the stylesheet: on a narrow window only one of
  // the two columns exists at a time.
  const view = stepped && !showPage ? "list" : "page";

  return (
    <Modal
      width="min(940px, calc(100vw - 48px))"
      className="modal-settings"
      onClose={onClose}
    >
      <div className="modal-header settings-header">
        <h2>{t("common.settings")}</h2>
        <span
          className="settings-mode"
          title={t("settings.dialog.modeTitle", { mode: modeName })}
        >
          {modeName}
        </span>
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

      <div className="settings-body" data-view={view}>
        <nav className="settings-nav" aria-label={t("common.settings")}>
          {groups.map((group) => (
            <div key={group.scope} className="settings-nav-group">
              <h3 className="settings-nav-heading">
                {group.scope === "common"
                  ? t("settings.nav.common")
                  : t("settings.nav.onlyInMode", { mode: modeName })}
              </h3>
              {group.entries.map((navEntry) => {
                const item = navEntry as SettingsCategoryEntry;
                const active = category === navEntry.id;
                return (
                  <button
                    type="button"
                    key={navEntry.id}
                    className={`settings-nav-item${active ? " active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => openCategory(navEntry.id)}
                  >
                    {item.icon}
                    <span className="settings-nav-text">
                      <span className="settings-nav-label">
                        {t(navEntry.labelKey)}
                      </span>
                      {
                        /* Drawn by the compact layout only (settings.css): the
                          page header prints the same line where both are on
                          screen at once. */
                      }
                      <span className="settings-nav-desc">
                        {t(navEntry.descriptionKey)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="settings-content">
          <SettingsPage
            title={t(entry?.labelKey ?? "common.settings")}
            description={entry === undefined
              ? undefined
              : t(entry.descriptionKey)}
            onBack={stepped ? () => setShowPage(false) : undefined}
          >
            {entry?.render(panels)}
          </SettingsPage>
        </div>
      </div>
    </Modal>
  );
}
