import type { AppMode } from "@lumisca/core/shared";
import {
  IconCode,
  IconHistory,
  IconMenu2,
  IconPlus,
  IconPower,
  IconSettings,
  IconSparkles,
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
  | { kind: "switchMode"; to: AppMode }
  | { kind: "settings" }
  | { kind: "quit" }
  | { kind: "separator" };

/**
 * Which entries the menu holds, in the mode the reader is in.
 *
 * Code mode adds the tab actions. stella mode has one conversation per agent
 * and no tab strip, so "new tab" and "session history" there would open code
 * mode's machinery inside a conversation view. The rest — the switch, the
 * settings, the quit — belong to the app and stay in both.
 *
 * The switch entry names the OTHER mode and does it in one press. It used to
 * say "switch mode" and open a chooser, which made the reader read two cards
 * to say what the menu could have said in one line.
 */
export function menuEntries(options: {
  mode: AppMode;
  isDesktop: boolean;
}): AppMenuEntry[] {
  return [
    ...(options.mode === "code"
      ? [
          { kind: "newTab" } as const,
          { kind: "history" } as const,
          { kind: "separator" } as const,
        ]
      : []),
    { kind: "switchMode", to: options.mode === "code" ? "stella" : "code" },
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
  /** Switch to `next`. The menu only ever names the other mode, so this is
   * one press and no further screen. A refusal (stella where the server has
   * no machine) is the caller's to show; the menu closes either way. */
  onSwitchMode: (next: AppMode) => void;
  isDesktop: boolean;
  /** The mode this client shows. Decides the switch entry's destination and
   * the tab actions: stella mode has one conversation per agent and no tab
   * bar, so a "new tab" entry would open code mode's empty draft inside the
   * conversation view — a control that cannot do what it says. */
  mode: AppMode;
  /** Extra class for the trigger button (it lives in the title bar on
   * desktop, in the tab bar in a plain browser). */
  buttonClass?: string;
}

/** Hamburger app menu (new tab / session history / switch mode / settings /
 * quit). Shown in the desktop title bar next to the window controls, and at
 * the right end of the tab bar in a plain browser. */
export function AppMenu({
  onNew,
  onOpenRecent,
  onOpenSettings,
  onQuit,
  onSwitchMode,
  isDesktop,
  mode,
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
          {menuEntries({ mode, isDesktop }).map((entry) => {
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
              case "switchMode": {
                const code = entry.to === "code";
                return (
                  <button
                    type="button"
                    className="app-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      onSwitchMode(entry.to);
                    }}
                  >
                    {code ? <IconCode size={14} /> : <IconSparkles size={14} />}
                    <span>
                      {t("chrome.appMenu.switchTo", {
                        mode: t(
                          code
                            ? "chat.modeSelect.code.title"
                            : "chat.modeSelect.stella.title",
                        ),
                      })}
                    </span>
                  </button>
                );
              }
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
