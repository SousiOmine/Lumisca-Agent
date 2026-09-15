import { useRef, useState } from "preact/compat";
import {
  IconHistory,
  IconMenu2,
  IconPlus,
  IconPower,
  IconSettings,
} from "@tabler/icons-preact";
import { useClickOutside } from "../hooks/useClickOutside.ts";
import { useT } from "../i18n.ts";

interface AppMenuProps {
  onNew: () => void;
  /** Open the recent (closed) sessions modal. */
  onOpenRecent: () => void;
  onOpenSettings: () => void;
  /** Quit the desktop app (shown only when running in the shell). */
  onQuit: () => void;
  isDesktop: boolean;
  /** Extra class for the trigger button (it lives in the title bar on
   * desktop, in the tab bar in a plain browser). */
  buttonClass?: string;
  /** The docked pane is visible (shown): shift the menu left by the
   * pane width so it does not end up underneath the native pane window.
   * Must track visibility, not mere existence: a hidden-but-alive pane
   * (`open` without `visible`) has its native window hidden and needs
   * no avoidance. */
  paneVisible?: boolean;
}

/** The pane width in CSS pixels. Must match `--pane-width` in
 * styles/tokens.css and PANE_WIDTH in browser_lab.rs. */
const PANE_WIDTH = 460;

/** Hamburger app menu (new tab / session history / settings / quit). Shown
 * in the desktop title bar next to the window controls, and at the right
 * end of the tab bar in a plain browser. */
export function AppMenu({
  onNew,
  onOpenRecent,
  onOpenSettings,
  onQuit,
  isDesktop,
  buttonClass = "icon-btn",
  paneVisible = false,
}: AppMenuProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Close on outside click.
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
            right: globalThis.innerWidth - pos.x +
              (paneVisible ? PANE_WIDTH : 0),
          }}
        >
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
          <div className="app-menu-sep" role="separator" />
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
          {isDesktop && (
            <>
              <div className="app-menu-sep" role="separator" />
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
