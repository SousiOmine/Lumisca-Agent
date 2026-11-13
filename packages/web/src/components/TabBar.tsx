import type { AppMode } from "@lumisca/core/shared";
import { IconChevronRight, IconPlus, IconX } from "@tabler/icons-preact";
import { memo, useEffect, useRef, useState } from "preact/compat";
import { useClickOutside } from "../hooks/useClickOutside.ts";
import { useT } from "../i18n.ts";
import { AppMenu } from "./AppMenu.tsx";

/** What the bar renders of one tab. The App derives it from the live view
 * map, which is replaced on every streamed event: this list is rebuilt each
 * time, and the memoized bar compares it by value (see sameTabBar) rather
 * than by identity. */
export interface TabSummary {
  id: string;
  /** Session name; null while the session has none yet (the bar shows its
   * own "new session" label instead). */
  name: string | null;
  /** Model id; appended to the tab's tooltip, which carries the whole name
   * the strip had to clip. */
  modelId: string | null;
  active: boolean;
  running: boolean;
  /** The tool the running agent is executing now (badge); absent when no
   * tool is in flight. */
  runningTool?: string;
}

interface TabBarProps {
  tabs: TabSummary[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseToRight: (id: string) => void;
  onCloseToLeft: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onNew: () => void;
  /** Open the recent (closed) sessions modal. */
  onOpenRecent: () => void;
  onOpenSettings: () => void;
  isDesktop: boolean;
  onQuit: () => void;
  /** Switch to the other mode, in one press (see AppMenu). */
  onSwitchMode: (mode: AppMode) => void;
}

/** State of the open right-click menu: target tab and cursor position. */
interface TabMenu {
  tabId: string;
  x: number;
  y: number;
}

const MENU_MARGIN = 8;

/** The tab strip. Memoized, and compared by value: the App hands it a list
 * it rebuilds on every event of the session stream (the views behind it are
 * new objects each time), so an identity comparison would re-render the
 * strip per streamed token while nothing it draws has changed. */
export const TabBar = memo(TabBarView, sameTabBar);

/** Whether two renders of the bar would draw the same thing: the tab list by
 * value, every other prop by identity (each is a callback the App keeps
 * stable, or a primitive). A new field of TabSummary has to be compared here
 * too — the list is new every event, so an unread field would leave a stale
 * tab on screen. */
function sameTabBar(previous: TabBarProps, next: TabBarProps): boolean {
  return (
    previous.isDesktop === next.isDesktop &&
    previous.onSelect === next.onSelect &&
    previous.onClose === next.onClose &&
    previous.onCloseToRight === next.onCloseToRight &&
    previous.onCloseToLeft === next.onCloseToLeft &&
    previous.onCloseOthers === next.onCloseOthers &&
    previous.onNew === next.onNew &&
    previous.onOpenRecent === next.onOpenRecent &&
    previous.onOpenSettings === next.onOpenSettings &&
    previous.onQuit === next.onQuit &&
    previous.onSwitchMode === next.onSwitchMode &&
    sameTabs(previous.tabs, next.tabs)
  );
}

/** Element-wise shallow equality: a tab is the same when everything it draws
 * — and its id, which keys the row — still matches. */
function sameTabs(previous: TabSummary[], next: TabSummary[]): boolean {
  return (
    previous.length === next.length &&
    next.every((tab, index) => {
      const before = previous[index];
      return (
        before === tab ||
        (before !== undefined &&
          before.id === tab.id &&
          before.name === tab.name &&
          before.modelId === tab.modelId &&
          before.active === tab.active &&
          before.running === tab.running &&
          before.runningTool === tab.runningTool)
      );
    })
  );
}

function TabBarView({
  tabs,
  onSelect,
  onClose,
  onCloseToRight,
  onCloseToLeft,
  onCloseOthers,
  onNew,
  onOpenRecent,
  onOpenSettings,
  isDesktop,
  onQuit,
  onSwitchMode,
}: TabBarProps) {
  const t = useT();
  const [menu, setMenu] = useState<TabMenu | null>(null);
  // Clamped menu position: rendered at the cursor first, then adjusted once
  // the menu is measured so it never leaves the viewport.
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [submenuOpen, setSubmenuOpen] = useState(false);
  // The submenu opens to the right of its trigger, flipped to the left when
  // there is not enough room.
  const [flipLeft, setFlipLeft] = useState(false);
  // In a viewport so narrow that even the flipped submenu would leave the
  // screen, pin it over the menu instead of letting it clip off-screen.
  const [clampLeft, setClampLeft] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  /** Open the menu at a point. The pointer supplies that point, and so does
   * the keyboard: the ContextMenu key (and Shift+F10) has no cursor
   * position, so the tab's own corner stands in for it. Both routes go
   * through here, because the menu holds the bulk closes ("close the others")
   * that no other control offers. */
  const openMenu = (id: string, x: number, y: number) => {
    setMenu({ tabId: id, x, y });
    setPos({ x, y });
    setSubmenuOpen(false);
  };

  // Measure the rendered menu and clamp its position to the viewport;
  // flip the submenu to the left when it would overflow the right edge.
  useEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const subWidth = submenuRef.current?.getBoundingClientRect().width ?? 200;
    const x = Math.max(
      MENU_MARGIN,
      Math.min(menu.x, globalThis.innerWidth - rect.width - MENU_MARGIN),
    );
    const y = Math.max(
      MENU_MARGIN,
      Math.min(menu.y, globalThis.innerHeight - rect.height - MENU_MARGIN),
    );
    setPos({ x, y });
    setFlipLeft(x + rect.width + subWidth > globalThis.innerWidth);
    setClampLeft(
      x + rect.width + subWidth > globalThis.innerWidth &&
        x - subWidth < MENU_MARGIN,
    );
  }, [menu]);

  // Close on outside click, Escape, tab-bar scroll and window blur.
  useClickOutside(menuRef, () => setMenu(null), menu !== null, {
    onScroll: true,
    onBlur: true,
  });

  const menuIndex = menu ? tabs.findIndex((tab) => tab.id === menu.tabId) : -1;
  const isRightmost = menuIndex === tabs.length - 1;
  const isLeftmost = menuIndex === 0;

  return (
    <div
      className="tabbar"
      role="tablist"
      aria-label={t("chrome.tabBar.label")}
    >
      {tabs.map(({ id, name, modelId, active, running, runningTool }) => {
        return (
          <div
            key={id}
            role="tab"
            aria-selected={active}
            // Tabs are reachable and switchable from the keyboard: Tab moves
            // the focus into the strip, Enter / Space activates, and the
            // arrow keys move between tabs (the standard tablist pattern).
            tabIndex={active ? 0 : -1}
            className={`tab${active ? " active" : ""}`}
            onClick={() => onSelect(id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(id);
                return;
              }
              // The keyboard's own "open the context menu" keys. The point
              // is the tab's bottom-left corner, which is where the pointer
              // menu would open for a click on the label.
              if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                openMenu(id, rect.left, rect.bottom);
                return;
              }
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                return;
              }
              event.preventDefault();
              const index = tabs.findIndex((tab) => tab.id === id);
              const delta = event.key === "ArrowRight" ? 1 : -1;
              const next = tabs[(index + delta + tabs.length) % tabs.length];
              if (next !== undefined) onSelect(next.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(id, e.clientX, e.clientY);
            }}
            // The strip clips long names, so the tooltip has to carry the
            // whole one — and the model beside it, which the tab itself has
            // no room for.
            title={
              modelId === null
                ? (name ?? t("chrome.tabBar.newSession"))
                : `${name ?? t("chrome.tabBar.newSession")} — ${modelId}`
            }
          >
            {running && (
              <span
                className="live-dot"
                aria-label={t("chrome.tabBar.processing")}
              />
            )}
            <span className="tab-name">
              {name ?? t("chrome.tabBar.newSession")}
            </span>
            {running && runningTool && (
              <span className="tab-badge">{runningTool}</span>
            )}
            <button
              type="button"
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(id);
              }}
              title={t("chrome.tabBar.closeTab")}
              aria-label={t("chrome.tabBar.closeTabNamed", { name })}
            >
              <IconX size={13} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="tab-new"
        onClick={onNew}
        title={t("chrome.tabBar.newSession")}
        aria-label={t("chrome.tabBar.newSession")}
      >
        <IconPlus size={17} />
      </button>
      {/* On desktop the app menu lives in the title bar next to the window
       * controls; in a plain browser (no title bar) it stays here. */}
      {!isDesktop && (
        <div className="tabbar-actions">
          <AppMenu
            onNew={onNew}
            onOpenRecent={onOpenRecent}
            onOpenSettings={onOpenSettings}
            onQuit={onQuit}
            onSwitchMode={onSwitchMode}
            isDesktop={false}
            mode="code"
          />
        </div>
      )}

      {menu && (
        <div
          ref={menuRef}
          className="tab-context-menu"
          style={{ left: pos.x, top: pos.y }}
          role="menu"
        >
          <button
            type="button"
            className="tab-context-item"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              onNew();
            }}
          >
            <IconPlus size={14} />
            <span>{t("chrome.tabBar.openNewTab")}</span>
          </button>
          <div className="tab-context-sep" role="separator" />
          <button
            type="button"
            className="tab-context-item"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              onClose(menu.tabId);
            }}
          >
            <IconX size={14} />
            <span>{t("chrome.tabBar.closeTab")}</span>
          </button>
          <div
            className="tab-context-item tab-context-submenu-trigger"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={submenuOpen}
            onMouseEnter={() => setSubmenuOpen(true)}
            onMouseLeave={() => setSubmenuOpen(false)}
          >
            <span>{t("chrome.tabBar.closeOtherTabs")}</span>
            <IconChevronRight size={14} />
            <div
              ref={submenuRef}
              className={`tab-context-submenu${submenuOpen ? "" : " hidden"}${
                flipLeft ? " flip-left" : ""
              }${clampLeft ? " clamp-left" : ""}`}
              role="menu"
            >
              <button
                type="button"
                className="tab-context-item"
                role="menuitem"
                disabled={isRightmost}
                onClick={() => {
                  setMenu(null);
                  onCloseToRight(menu.tabId);
                }}
              >
                {t("chrome.tabBar.closeAllRight")}
              </button>
              <button
                type="button"
                className="tab-context-item"
                role="menuitem"
                disabled={isLeftmost}
                onClick={() => {
                  setMenu(null);
                  onCloseToLeft(menu.tabId);
                }}
              >
                {t("chrome.tabBar.closeAllLeft")}
              </button>
              <button
                type="button"
                className="tab-context-item"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  onCloseOthers(menu.tabId);
                }}
              >
                {t("chrome.tabBar.closeAllOthers")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
