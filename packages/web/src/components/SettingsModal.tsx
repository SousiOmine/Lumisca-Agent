import { IconX } from "@tabler/icons-preact";
import type { ReactNode } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import { useCodeModeEnabled } from "../codeMode.ts";
import { useConnectionSwitch } from "../hooks/useConnectionSwitch.ts";
import { COMPACT_QUERY, useMediaQuery } from "../hooks/useMediaQuery.ts";
import type { PushControls } from "../hooks/usePush.ts";
import type { UpdateControls } from "../hooks/useUpdateStatus.ts";
import { useT } from "../i18n.ts";
import { reloadCatalog, useUserProviders } from "../providers.ts";
import { inDesktopShell } from "../shell.ts";
import type { Locale, ThemeSetting } from "../types.ts";
import { Modal } from "./Modal.tsx";
import { AddProviderFlow } from "./settings/AddProviderFlow.tsx";
import { AddUserProviderForm } from "./settings/AddUserProviderForm.tsx";
import { AppPanel } from "./settings/AppPanel.tsx";
import { CommandSafetyPanel } from "./settings/CommandSafetyPanel.tsx";
import { ComputerUsePanel } from "./settings/ComputerUsePanel.tsx";
import { ConnectionsPanel } from "./settings/ConnectionsPanel.tsx";
import {
  ownerGroups,
  ownerLabelKey,
  type SettingsCategory,
  type SettingsNavEntry,
  visibleCategories,
} from "./settings/categories.ts";
import { ExperimentalPanel } from "./settings/ExperimentalPanel.tsx";
import { McpList } from "./settings/McpList.tsx";
import { ModelsPage } from "./settings/ModelsPage.tsx";
import { NotificationsPanel } from "./settings/NotificationsPanel.tsx";
import { OverviewPanel } from "./settings/OverviewPanel.tsx";
import { PersonalizePanel } from "./settings/PersonalizePanel.tsx";
import { ProviderDetail } from "./settings/ProviderDetail.tsx";
import { ProviderList } from "./settings/ProviderList.tsx";
import { SavedPromptsPanel } from "./settings/SavedPromptsPanel.tsx";
import { ServerHeading } from "./settings/ServerHeading.tsx";
import { SettingsPage } from "./settings/SettingsPage.tsx";
import { WebSearchPanel } from "./settings/WebSearchPanel.tsx";

export type { SettingsCategory } from "./settings/categories.ts";

interface SettingsModalProps {
  theme: ThemeSetting;
  onThemeChange: (theme: ThemeSetting) => void;
  /** The app language and the persist failure of the last change (shown in
   * the server overview). */
  language: Locale;
  languageError: string | null;
  onLanguageChange: (language: Locale) => void;
  update: UpdateControls;
  /** Background agent-event notifications (desktop only). */
  notifyEnabled: boolean;
  onNotifyEnabledChange: (enabled: boolean) => void;
  /** PWA notifications (Web Push) of this device. */
  push: PushControls;
  /** The page the address names, or null when it names none (`…/settings`:
   * the app menu's way in). The dialog does not choose it — picking another
   * page is a navigation (see `onOpenCategory`), which is what makes every
   * category linkable and the back button walk through them. */
  category: SettingsCategory | null;
  /** Move to another category (a navigation: the address names the page). */
  onOpenCategory: (category: SettingsCategory | null) => void;
  /** Back from a category page to the category list, on the narrow layout
   * where the two are two screens. A navigation like the one above — the
   * address says which of the two is showing — so the browser's back and this
   * button are the same move. */
  onBackToList: () => void;
  onClose: () => void;
}

/** What each panel needs. One object instead of one prop per panel: the table
 * below renders them, so the wiring lives next to the entry that uses it. */
interface PanelContext {
  props: SettingsModalProps;
  /** Switch to another category (a panel's "open the provider settings" link
   * reaches across). */
  openCategory: (id: SettingsCategory) => void;
  /** The providers category's own navigation state. */
  providersView: ProvidersView;
  setProvidersView: (view: ProvidersView) => void;
  userProviders: ReturnType<typeof useUserProviders>;
}

interface SettingsCategoryEntry extends SettingsNavEntry {
  /** The page's body. The entry's label is the page title; a screen pushed
   * from inside the page draws its own bar (SubHeader). */
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
 * The navigation table, in reading order: this device's pages, then the
 * server's. The owner is the first level because it is the question the
 * dialog could not answer (see categories.ts).
 *
 * Each entry carries its page: navigation and body used to be two separate
 * lists, so adding a category meant editing three places and a forgotten one
 * was not a type error. One table cannot drift from itself.
 *
 * One page is code mode's alone: saved prompts feed the slash menu, which
 * exists only in code mode's composer. It is a page of its own rather than a
 * section of 実験的機能 (a list of snippets under a row of switches), and it
 * is drawn only while code mode is offered (see visibleCategories).
 *
 * Nothing here belongs to one agent. Routines schedule requests on one
 * agent's conversation, so they are not a category at all: the agent's own
 * row in the stella list opens them (StellaSidebar).
 */
const CATEGORIES: readonly SettingsCategoryEntry[] = [
  {
    id: "app",
    owner: "device",
    labelKey: "settings.nav.app",
    render: ({ props }) => (
      <AppPanel
        theme={props.theme}
        onThemeChange={props.onThemeChange}
        status={props.update.status}
        source={props.update.source}
        bridgeError={props.update.error}
        failure={props.update.failure}
        onSetAuto={props.update.setAuto}
        onSetAutoRestart={props.update.setAutoRestart}
        onCheck={props.update.check}
        onDownload={props.update.download}
        onInstall={props.update.install}
        onRestart={props.update.restart}
      />
    ),
  },
  {
    id: "notifications",
    owner: "device",
    labelKey: "settings.nav.notifications",
    render: ({ props }) => (
      <NotificationsPanel
        source={props.update.source}
        notifyEnabled={props.notifyEnabled}
        onNotifyEnabledChange={props.onNotifyEnabledChange}
        push={props.push}
      />
    ),
  },
  {
    id: "connections",
    owner: "device",
    deviceOnly: true,
    labelKey: "settings.nav.connections",
    render: () => <ConnectionsPanel />,
  },
  {
    id: "overview",
    owner: "server",
    labelKey: "settings.nav.overview",
    render: ({ props }) => (
      <OverviewPanel
        status={props.update.status}
        source={props.update.source}
        bridgeError={props.update.error}
        failure={props.update.failure}
        language={props.language}
        languageError={props.languageError}
        onLanguageChange={props.onLanguageChange}
        onSetAuto={props.update.setAuto}
        onSetAutoRestart={props.update.setAutoRestart}
        onCheck={props.update.check}
        onDownload={props.update.download}
        onInstall={props.update.install}
        onRestart={props.update.restart}
      />
    ),
  },
  {
    id: "providers",
    owner: "server",
    labelKey: "settings.nav.providers",
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
                })
              }
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
                setProvidersView({ kind: "editUser", providerId })
              }
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
    owner: "server",
    labelKey: "settings.nav.models",
    render: ({ openCategory }) => (
      <ModelsPage onOpenProviders={() => openCategory("providers")} />
    ),
  },
  {
    id: "mcp",
    owner: "server",
    labelKey: "settings.nav.mcp",
    render: () => <McpList />,
  },
  {
    id: "personalize",
    owner: "server",
    labelKey: "settings.nav.personalize",
    render: () => <PersonalizePanel />,
  },
  {
    id: "security",
    owner: "server",
    labelKey: "settings.nav.security",
    // The command check guards every bash / eval call, so both modes have it.
    // Computer use is the other half of "what may the agent do": one page, one
    // question, with the code-only scope said under its own heading.
    render: () => (
      <>
        <CommandSafetyPanel />
        <ComputerUsePanel />
      </>
    ),
  },
  {
    id: "experimental",
    owner: "server",
    labelKey: "settings.nav.experimental",
    // The scripting tool call reaches both modes' sessions, so the page is
    // shared rather than one mode's.
    render: () => <ExperimentalPanel />,
  },
  {
    id: "prompts",
    owner: "server",
    codeModeOnly: true,
    labelKey: "settings.nav.prompts",
    // After 実験的機能 because that page is where code mode is switched on:
    // this page appears once it is, directly below the switch that made it.
    render: () => <SavedPromptsPanel />,
  },
];

/**
 * The settings dialog: a navigation of two owners on the left, one page on
 * the right.
 *
 * The first level is the owner, because that is the question a flat list
 * could not answer: notifications, theme and the updater lived on the same
 * pages while belonging to different machines (see categories.ts). The
 * server's group is headed by its name and address, so "whose settings are
 * these" is read before the first row.
 *
 * A category is a page: its title stays at the top while the body scrolls
 * (SettingsPage). A page that only code mode's sessions use says so in one
 * line under the title. Narrow windows get one screen at a time — the
 * navigation, then the page with a back button.
 */
export function SettingsModal({
  theme,
  onThemeChange,
  language,
  languageError,
  onLanguageChange,
  update,
  notifyEnabled,
  onNotifyEnabledChange,
  push,
  category,
  onOpenCategory,
  onBackToList,
  onClose,
}: SettingsModalProps) {
  const t = useT();
  const stepped = useMediaQuery(COMPACT_QUERY);
  const desktop = inDesktopShell();
  const codeMode = useCodeModeEnabled();
  const connection = useConnectionSwitch();
  const entries = visibleCategories(CATEGORIES, desktop, codeMode);
  const groups = ownerGroups(entries);
  /** The page being shown. Without one in the address this is the dialog's
   * own: 概要 beside the navigation, the first screen of the list. The
   * reader's clicks move it, and move the address with it (openCategory). */
  const [shown, setShown] = useState<SettingsCategory>(category ?? "overview");
  const [providersView, setProvidersView] = useState<ProvidersView>({
    kind: "list",
  });
  const userProviders = useUserProviders();
  const entry =
    entries.find((candidate) => candidate.id === shown) ??
    entries.find((candidate) => candidate.id === "overview") ??
    entries[0]!;
  // Which of the two screens the narrow layout is showing. On a wide window
  // both fit, so this is always the page. On a narrow one it is the address's
  // answer: a page named means the page, no page named means the list that
  // leads to one.
  const view = stepped && category === null ? "list" : "page";

  // The address is the page: a link, a back or a forward moves it, and this
  // follows. It is also where a category change lands, since the click goes
  // through onOpenCategory.
  useEffect(() => {
    if (category === null) return;
    setShown(category);
    // A category change drops the previous category's own screens (a
    // provider detail does not exist in the MCP list).
    setProvidersView({ kind: "list" });
  }, [category]);

  /** Move to another category. The navigation is the address's (see
   * SettingsModalProps.onOpenCategory); this only resets the category's own
   * screens, which a new category cannot keep. */
  const openCategory = (id: SettingsCategory) => {
    setProvidersView({ kind: "list" });
    onOpenCategory(id);
  };

  const panels: PanelContext = {
    openCategory,
    // The remaining props are the same object the modal received; the panels
    // read what they need from it.
    props: {
      theme,
      onThemeChange,
      language,
      languageError,
      onLanguageChange,
      update,
      notifyEnabled,
      onNotifyEnabledChange,
      push,
      category,
      onOpenCategory,
      onBackToList,
      onClose,
    },
    providersView,
    setProvidersView,
    userProviders,
  };

  return (
    <Modal
      width="min(940px, calc(100vw - 48px))"
      className="modal-settings"
      onClose={onClose}
      label={t("common.settings")}
    >
      {(close) => (
        <>
          <div className="modal-header settings-header">
            <h2>{t("common.settings")}</h2>
            <button
              type="button"
              className="icon-btn push"
              onClick={() => close()}
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <IconX size={16} />
            </button>
          </div>

          <div className="settings-body" data-view={view}>
            <nav className="settings-nav" aria-label={t("common.settings")}>
              {groups.map((group) => (
                <div key={group.owner} className="settings-nav-group">
                  {group.owner === "server" ? (
                    <ServerHeading connection={connection} />
                  ) : (
                    <h3 className="settings-nav-heading">
                      {t(ownerLabelKey(group.owner))}
                    </h3>
                  )}
                  {group.entries.map((navEntry) => {
                    const active = entry.id === navEntry.id;
                    return (
                      <button
                        type="button"
                        key={navEntry.id}
                        className={`settings-nav-item${
                          active ? " active" : ""
                        }`}
                        aria-current={active ? "page" : undefined}
                        onClick={() => openCategory(navEntry.id)}
                      >
                        <span className="settings-nav-label">
                          {t(navEntry.labelKey)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </nav>

            <div className="settings-content">
              <SettingsPage
                title={t(entry.labelKey)}
                onBack={stepped ? onBackToList : undefined}
              >
                {entry.render(panels)}
              </SettingsPage>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
