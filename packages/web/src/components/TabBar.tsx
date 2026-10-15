import {
  memo,
  type MouseEvent,
  useEffect,
  useRef,
  useState,
} from "preact/compat";
import { IconChevronRight, IconPlus, IconX } from "@tabler/icons-preact";
import { useClickOutside } from "../hooks/useClickOutside.ts";
import { useT } from "../i18n.ts";
import { AppMenu } from "./AppMenu.tsx";

/** What the bar renders of one tab. The App derives it from the live view
 * map, so the bar re-renders only when a label or a run state changes —
 * the map itself is replaced on every streamed event. */
export interface TabSummary {
  id: string;
  /** Session name; null while the session has none yet (the bar shows its
   * own "new session" label instead). */
  name: string | null;
  /** Model id, shown as the tab's tooltip. */
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
}

/** State of the open right-click menu: target tab and cursor position. */
interface TabMenu {
  tabId: string;
  x: number;
  y: number;
}

const MENU_MARGIN = 8;

/** The tab strip. Memoized: the App hands it a summarized list and stable
 * callbacks, so an event that only appends to a session's message log does
 * not re-render the bar (the session views it renders from are rebuilt on
 * every event). */
export const TabBar = memo(TabBarView);

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

  const openMenu = (id: string, e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setMenu({ tabId: id, x: e.clientX, y: e.clientY });
    setPos({ x: e.clientX, y: e.clientY });
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
            className={`tab${active ? " active" : ""}`}
            onClick={() => onSelect(id)}
            onContextMenu={(e) => openMenu(id, e)}
            title={modelId ?? t("chrome.tabBar.newSession")}
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
      {
        /* On desktop the app menu lives in the title bar next to the window
       * controls; in a plain browser (no title bar) it stays here. */
      }
      {!isDesktop && (
        <div className="tabbar-actions">
          <AppMenu
            onNew={onNew}
            onOpenRecent={onOpenRecent}
            onOpenSettings={onOpenSettings}
            onQuit={onQuit}
            isDesktop={false}
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
