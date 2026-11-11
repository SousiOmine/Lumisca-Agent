import {
  IconArrowsLeftRight,
  IconHistory,
  IconMenu2,
  IconPlus,
  IconPower,
  IconSettings,
} from "@tabler/icons-preact";
import { useRef, useState } from "preact/compat";
import { useClickOutside } from "../hooks/useClickOutside.ts";
import { useT } from "../i18n.ts";

/** One entry of the app menu, as the list decides it (see menuEntries).
 * Declared apart from the markup so the per-mode composition can be tested
 * without opening the menu in a browser. */
export type AppMenuEntry =
  | { kind: "newTab" }
  | { kind: "history" }
  | { kind: "switchMode" }
  | { kind: "settings" }
  | { kind: "quit" }
  | { kind: "separator" };

/**
 * Which entries the menu holds.
 *
 * `tabs` is code mode's: stella mode has one conversation per agent and no
 * tab strip, so "new tab" and "session history" there would open code mode's
 * machinery inside a conversation view. The rest — switch mode, settings,
 * quit — belong to the app and stay in both.
 */
export function menuEntries(options: {
  tabs: boolean;
  isDesktop: boolean;
}): AppMenuEntry[] {
  return [
    ...(options.tabs
      ? [
          { kind: "newTab" } as const,
          { kind: "history" } as const,
          { kind: "separator" } as const,
        ]
      : []),
    { kind: "switchMode" },
    { kind: "settings" },
    ...(options.isDesktop
      ? [{ kind: "separator" } as const, { kind: "quit" } as const]
      : []),
  ];
}

interface AppMenuProps {
  onNew: () => void;
  /** Open the recent (closed) sessions modal. */
  onOpenRecent: () => void;
  onOpenSettings: () => void;
  /** Quit the desktop app (shown only when running in the shell). */
  onQuit: () => void;
  /** Open the mode-selection screen (code / stella). */
  onSwitchMode: () => void;
  isDesktop: boolean;
  /** Whether this client shows tabs (code mode). stella mode has one
   * conversation per agent and no tab bar, so a "new tab" entry would open
   * code mode's empty draft inside the conversation view — a control that
   * cannot do what it says. Omitted → true (the menu is code mode's by
   * default; stella passes `false`). */
  tabs?: boolean;
  /** Extra class for the trigger button (it lives in the title bar on
   * desktop, in the tab bar in a plain browser). */
  buttonClass?: string;
}

/** Hamburger app menu (new tab / session history / settings / quit). Shown
 * in the desktop title bar next to the window controls, and at the right
 * end of the tab bar in a plain browser. */
export function AppMenu({
  onNew,
  onOpenRecent,
  onOpenSettings,
  onQuit,
  onSwitchMode,
  isDesktop,
  tabs = true,
  buttonClass = "icon-btn",
}: AppMenuProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useClickOutside(menuRef, () => setOpen(false), open);

  return (
    <div className="app-menu-wrapper" ref={menuRef}>
      <button
        type="button"
        className={buttonClass}
        ref={btnRef}
        onClick={() => {
          if (!open && btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect();
            setPos({ x: rect.right, y: rect.bottom + 4 });
          }
          setOpen((v) => !v);
        }}
        title={t("chrome.appMenu.title")}
        aria-label={t("chrome.appMenu.title")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconMenu2 size={17} />
      </button>
      {open && (
        <div
          className="app-menu"
          role="menu"
          style={{
            position: "fixed",
            top: pos.y,
            right: globalThis.innerWidth - pos.x,
          }}
        >
          {menuEntries({ tabs, isDesktop }).map((entry) => {
            switch (entry.kind) {
              case "separator":
                return <div className="app-menu-sep" role="separator" />;
              case "newTab":
                return (
                  <button
                    type="button"
                    className="app-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      onNew();
                    }}
                  >
                    <IconPlus size={14} />
                    <span>{t("chrome.appMenu.newTab")}</span>
                    <span className="app-menu-shortcut">Ctrl+T</span>
                  </button>
                );
              case "history":
                return (
                  <button
                    type="button"
                    className="app-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      onOpenRecent();
                    }}
                  >
                    <IconHistory size={14} />
                    <span>{t("chrome.appMenu.history")}</span>
                  </button>
                );
              case "switchMode":
                return (
                  <button
                    type="button"
                    className="app-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      onSwitchMode();
                    }}
                  >
                    <IconArrowsLeftRight size={14} />
                    <span>{t("chrome.appMenu.switchMode")}</span>
                  </button>
                );
              case "settings":
                return (
                  <button
                    type="button"
                    className="app-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      onOpenSettings();
                    }}
                  >
                    <IconSettings size={14} />
                    <span>{t("common.settings")}</span>
                  </button>
                );
              case "quit":
                return (
                  <button
                    type="button"
                    className="app-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      onQuit();
                    }}
                  >
                    <IconPower size={14} />
                    <span>{t("chrome.appMenu.quit")}</span>
                  </button>
                );
            }
          })}
        </div>
      )}
    </div>
  );
}
