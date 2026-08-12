import { type MouseEvent, useEffect, useRef, useState } from "react";
import { IconChevronRight, IconPlus, IconX } from "@tabler/icons-react";
import { isViewRunning, type SessionView } from "../types.ts";
import { useClickOutside } from "../hooks/useClickOutside.ts";
import { AppMenu } from "./AppMenu.tsx";

interface TabBarProps {
  tabs: string[];
  views: Map<string, SessionView>;
  activeTab: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseToRight: (id: string) => void;
  onCloseToLeft: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onNew: () => void;
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

export function TabBar({
  tabs,
  views,
  activeTab,
  onSelect,
  onClose,
  onCloseToRight,
  onCloseToLeft,
  onCloseOthers,
  onNew,
  onOpenSettings,
  isDesktop,
  onQuit,
}: TabBarProps) {
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

  const openMenu = (id: string, e: MouseEvent) => {
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

  const menuIndex = menu ? tabs.indexOf(menu.tabId) : -1;
  const isRightmost = menuIndex === tabs.length - 1;
  const isLeftmost = menuIndex === 0;

  return (
    <div className="tabbar" role="tablist" aria-label="セッションタブ">
      {tabs.map((id) => {
        const view = views.get(id);
        const isActive = id === activeTab;
        const isRunning = view !== undefined && isViewRunning(view);
        const runningTool = view?.runningTools.values().next().value as
          | string
          | undefined;
        const name = view?.info.name ?? "新規セッション";
        return (
          <div
            key={id}
            role="tab"
            aria-selected={isActive}
            className={`tab${isActive ? " active" : ""}`}
            onClick={() => onSelect(id)}
            onContextMenu={(e) => openMenu(id, e)}
            title={view?.info.modelId ?? "新規セッション"}
          >
            {isRunning && <span className="live-dot" aria-label="実行中" />}
            <span className="tab-name">{name}</span>
            {isRunning && runningTool && (
              <span className="tab-badge">{runningTool}</span>
            )}
            <button
              type="button"
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(id);
              }}
              title="タブを閉じる"
              aria-label={`${name} を閉じる`}
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
        title="新しいセッション"
        aria-label="新しいセッション"
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
            <span>新しいタブを開く</span>
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
            <span>タブを閉じる</span>
          </button>
          <div
            className="tab-context-item tab-context-submenu-trigger"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={submenuOpen}
            onMouseEnter={() => setSubmenuOpen(true)}
            onMouseLeave={() => setSubmenuOpen(false)}
          >
            <span>複数のタブを閉じる</span>
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
                右側のタブをすべて閉じる
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
                左側のタブをすべて閉じる
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
                他のタブをすべて閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
