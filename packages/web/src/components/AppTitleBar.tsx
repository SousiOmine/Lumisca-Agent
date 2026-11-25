import type { AppMode } from "@lumisca/core/shared";
import { IconPlus } from "@tabler/icons-preact";
import type { ReactElement } from "preact/compat";
import { useT } from "../i18n.ts";
import { quit } from "../shell.ts";
import type { StellaAgentSummary } from "../types.ts";
import { AppMenu } from "./AppMenu.tsx";
import { StellaTitleBarHeader } from "./stella/StellaTitleBarHeader.tsx";
import { TabBar, type TabSummary } from "./TabBar.tsx";
import { TitleBar } from "./TitleBar.tsx";

/** The actions the window's menus offer, in either mode: the ones that belong
 * to the app rather than to the screen underneath. */
export interface TitleBarActions {
  onNew: () => void;
  /** Open the recent (closed) sessions modal. */
  onOpenRecent: () => void;
  onOpenSettings: () => void;
  /** Switch modes in one press (see AppMenu). */
  onSwitchMode: (mode: AppMode) => void;
  /** Open settings → 接続先サーバー (the connection picker's "manage" entry,
   * which is a page the settings dialog can open on). */
  onManageConnections: () => void;
}

/**
 * What occupies the strip beside the app menu and the window controls — the
 * one thing that differs by mode, and by screen.
 *
 * `blank` is the first-run setup. The desktop window is undecorated, so that
 * screen has to be movable, closable and switchable too, but it has no tab
 * bar and no conversation to name.
 */
export type TitleBarStrip =
  | { kind: "blank" }
  | {
      kind: "tabs";
      /** The rows the bar draws (the App derives them from the live views,
       * which is why they are the bar's own summary type). */
      tabs: TabSummary[];
      /** A tab is a place: selecting one is a navigation (see useTabs). */
      onSelect: (id: string) => void;
      onClose: (id: string) => void;
      onCloseToRight: (id: string) => void;
      onCloseToLeft: (id: string) => void;
      onCloseOthers: (id: string) => void;
    }
  | StellaStripProps;

/** stella mode's strip, whose content is the open conversation rather than a
 * list of tabs. */
interface StellaStripProps {
  kind: "stella";
  /** The open agent's row, or null before the first selection. */
  agent: StellaAgentSummary | null;
  /** The conversation the address names, or null on the agent list. */
  agentId: string | null;
  /** Whether the list and the conversation are two screens (the compact
   * width and below): only then is there a way back to the list. */
  singleScreen: boolean;
  onBack: () => void;
  onEditAgent: () => void;
  /** Show or hide the machine's screen, absent while there is nothing to
   * show. */
  onToggleScreen?: () => void;
  screenOpen: boolean;
  onToggleSearch?: () => void;
  searchOpen?: boolean;
  /** Open the agent create dialog. This strip is the only place the list
   * screen has it at phone widths. */
  onCreateAgent: () => void;
}

export interface AppTitleBarProps {
  /** The mode this window shows: the app menu's switch entry names the other
   * one, and only code mode has a tab strip. */
  mode: AppMode;
  /** Whether this page runs inside the desktop shell's window. In a plain
   * browser the strip is not drawn at all (TitleBar returns the content
   * alone), so stella's strip has to carry the app menu itself. */
  desktop: boolean;
  actions: TitleBarActions;
  strip: TitleBarStrip;
}

/**
 * The window's strip: the app menu, the window controls, and the content the
 * current mode puts beside them.
 *
 * The strip is one surface with one contract (see TitleBar): what sits
 * between the drag handle and the controls, and what has to stay clickable
 * there. It was drawn inside App.tsx, in the same tree as both modes' bodies
 * and the dialogs.
 */
export function AppTitleBar({
  mode,
  desktop,
  actions,
  strip,
}: AppTitleBarProps): ReactElement {
  return (
    <TitleBar
      onNew={actions.onNew}
      onOpenRecent={actions.onOpenRecent}
      onOpenSettings={actions.onOpenSettings}
      onQuit={quit}
      onSwitchMode={actions.onSwitchMode}
      onManageConnections={actions.onManageConnections}
      mode={mode}
    >
      {strip.kind === "blank" && <div className="titlebar-blank" />}
      {strip.kind === "tabs" && (
        <TabBar
          tabs={strip.tabs}
          onSelect={strip.onSelect}
          onClose={strip.onClose}
          onCloseToRight={strip.onCloseToRight}
          onCloseToLeft={strip.onCloseToLeft}
          onCloseOthers={strip.onCloseOthers}
          onNew={actions.onNew}
          onOpenRecent={actions.onOpenRecent}
          onOpenSettings={actions.onOpenSettings}
          isDesktop={desktop}
          onQuit={quit}
          onSwitchMode={actions.onSwitchMode}
        />
      )}
      {strip.kind === "stella" && (
        <StellaStrip
          mode={mode}
          desktop={desktop}
          actions={actions}
          strip={strip}
        />
      )}
    </TitleBar>
  );
}

/**
 * stella mode's strip: the open conversation, and the app menu where the
 * desktop title bar does not hold one.
 *
 * stella has no tab strip: one conversation is the whole surface, so the
 * strip names that conversation instead of listing sessions. See
 * StellaTitleBarHeader: the agent's face and name are here because they were
 * a second strip inside the sheet, saying the same thing one line lower.
 */
function StellaStrip({
  mode,
  desktop,
  actions,
  strip,
}: {
  mode: AppMode;
  desktop: boolean;
  actions: TitleBarActions;
  strip: StellaStripProps;
}): ReactElement {
  const t = useT();
  return (
    <div className="stella-titlebar-strip">
      <StellaTitleBarHeader
        agent={strip.agent}
        onBack={
          strip.singleScreen && strip.agentId !== null
            ? strip.onBack
            : undefined
        }
        onEditAgent={strip.onEditAgent}
        onToggleScreen={strip.onToggleScreen}
        screenOpen={strip.screenOpen}
        onToggleSearch={strip.onToggleSearch}
        searchOpen={strip.searchOpen}
      />
      {/* The list's create button, in the one row above the list at phone
       * widths: the sidebar's own copy sits under this row and left a gap of
       * its own height between the menu and the list. Only the list screen
       * has it — a conversation has nothing to create from. */}
      {strip.singleScreen && strip.agentId === null && (
        <button
          type="button"
          className="icon-btn stella-new-agent"
          onClick={strip.onCreateAgent}
          title={t("chat.stella.agents.new")}
          aria-label={t("chat.stella.agents.new")}
        >
          <IconPlus size={15} />
        </button>
      )}
      {/* On desktop the app menu lives in the title bar's controls; in a
       * plain browser this strip is the only chrome stella mode has, so the
       * menu (settings, mode switch, session history) has to stay reachable
       * from here. */}
      {!desktop && (
        <div className="tabbar-actions">
          <AppMenu
            onNew={actions.onNew}
            onOpenRecent={actions.onOpenRecent}
            onOpenSettings={actions.onOpenSettings}
            onQuit={quit}
            onSwitchMode={actions.onSwitchMode}
            isDesktop={false}
            mode={mode}
          />
        </div>
      )}
    </div>
  );
}
