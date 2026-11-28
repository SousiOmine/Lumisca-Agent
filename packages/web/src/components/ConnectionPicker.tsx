import { IconChevronDown, IconServer } from "@tabler/icons-preact";
import { useRef, useState } from "preact/hooks";
import { connectionLabel } from "../connections.ts";
import { useClickOutside } from "../hooks/useClickOutside.ts";
import { useConnectionSwitch } from "../hooks/useConnectionSwitch.ts";
import { useT } from "../i18n.ts";

interface ConnectionPickerProps {
  /** Open settings → 接続先サーバー (the place servers are added and edited). */
  onManage: () => void;
}

/**
 * Which server this window shows, and how to show another one.
 *
 * The list belongs to the window (the shell's settings), and *which* entry
 * is displayed is the shell's state: it survives navigation (the page is
 * reloaded onto the chosen server) and a restart. Without this control the
 * answer is only inside settings → 接続先サーバー, one dialog deeper than the
 * question — a page served by a remote machine looks exactly like the local
 * one.
 *
 * It lives in the desktop title bar in the corner every desktop window keeps
 * its "where am I" affordance, beside the app menu. In a plain browser there
 * is no such ambiguity (the address bar is the answer) and no bridge to
 * switch with, so the title bar does not render and this control is not
 * shown.
 *
 * The state and the switch are shared with the settings dialog's server card
 * (hooks/useConnectionSwitch): one copy of the shell read and the registry
 * lookup, so the two surfaces cannot name the same server differently.
 */
export function ConnectionPicker({ onManage }: ConnectionPickerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, () => setOpen(false), open);
  const connection = useConnectionSwitch();
  const current = connection.currentLabel();

  const connect = (target: { id: string } | "local") => {
    // A failed switch keeps the list open with its error: closing it would
    // look like the window had moved while the page stayed.
    void connection.connect(target).then((switched) => {
      if (switched) setOpen(false);
    });
  };

  return (
    <div className="connection-picker" ref={rootRef}>
      <button
        type="button"
        className="titlebar-btn connection-picker-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("chrome.connections.current", { name: current })}
      >
        <IconServer size={14} />
        <span className="connection-picker-label">{current}</span>
        <span className={`connection-picker-chevron${open ? " open" : ""}`}>
          <IconChevronDown size={14} />
        </span>
      </button>

      {open && (
        <div className="connection-picker-popover" role="menu">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={connection.state?.mode === "local"}
            className={`connection-option${
              connection.state?.mode === "local" ? " selected" : ""
            }`}
            disabled={connection.busy !== null}
            onClick={() => connect("local")}
          >
            <IconServer size={14} />
            <span className="connection-option-name">
              {t("chrome.connections.local")}
            </span>
          </button>

          {connection.entries.length === 0 && (
            <p className="connection-picker-note">
              {t("chrome.connections.empty")}
            </p>
          )}
          {connection.entries.map((server) => (
            <button
              key={server.id}
              type="button"
              role="menuitemradio"
              aria-checked={connection.currentId === server.id}
              className={`connection-option${
                connection.currentId === server.id ? " selected" : ""
              }`}
              disabled={connection.busy !== null}
              title={server.url}
              onClick={() => connect(server)}
            >
              <IconServer size={14} />
              <span className="connection-option-name">
                {connectionLabel(server)}
              </span>
            </button>
          ))}

          {connection.error !== null && (
            <p className="error-text connection-picker-note" role="alert">
              {connection.error}
            </p>
          )}

          <div className="connection-picker-sep" />

          <button
            type="button"
            role="menuitem"
            className="connection-option manage"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            <span className="connection-option-name">
              {t("chrome.connections.manage")}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
