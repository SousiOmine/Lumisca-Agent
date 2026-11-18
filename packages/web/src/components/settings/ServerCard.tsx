import {
  IconCheck,
  IconChevronDown,
  IconServer,
  IconSettings,
} from "@tabler/icons-preact";
import { useState } from "preact/hooks";
import { connectionLabel, serverLabel } from "../../connections.ts";
import type { ConnectionSwitch } from "../../hooks/useConnectionSwitch.ts";
import { useT } from "../../i18n.ts";

/**
 * Settings → the server group's heading: which server the pages below belong
 * to, and how to show another one.
 *
 * The title bar already names the server, but the settings dialog is also
 * opened from a browser (no title bar) and on a narrow window (the chrome may
 * have no room for the name). More importantly, a name in the chrome answers
 * "where am I", not "whose settings are these": the card sits at the head of
 * the group, so the owner is read with the pages it owns.
 *
 * A browser cannot switch: the address bar is the switch, and a page cannot
 * change it without a shell bridge. The card says which server is serving the
 * page instead of drawing a control that would do nothing.
 */
export function ServerCard({
  connection,
  onManage,
}: {
  connection: ConnectionSwitch;
  onManage: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const label = connection.currentLabel();
  // The page URL carries the auth token in its query; serverLabel keeps the
  // host and drops the rest, which is the part a reader recognises.
  const address = connection.state?.url
    ? serverLabel(null, connection.state.url)
    : null;

  return (
    <div className="settings-server-card">
      <div className="settings-server-card-head">
        <IconServer size={16} />
        <div className="settings-server-card-text">
          <h3 className="settings-server-card-name" title={label}>
            {label}
          </h3>
          {connection.desktop ? (
            address !== null && address !== label ? (
              <span className="settings-server-card-address">{address}</span>
            ) : null
          ) : (
            <span className="settings-server-card-note">
              {t("settings.serverCard.browser")}
            </span>
          )}
        </div>
        <span className="settings-server-card-badge">
          {t("settings.serverCard.viewing")}
        </span>
      </div>

      {connection.desktop && (
        <div className="settings-server-card-actions">
          <button
            type="button"
            className="settings-server-card-switch"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {t("settings.serverCard.switch")}
            <span
              className={`settings-server-card-chevron${open ? " open" : ""}`}
            >
              <IconChevronDown size={13} />
            </span>
          </button>
          <button
            type="button"
            className="settings-server-card-manage"
            onClick={onManage}
          >
            <IconSettings size={13} />
            {t("settings.serverCard.manage")}
          </button>
        </div>
      )}

      {open && connection.desktop && (
        <div className="settings-server-choices">
          <button
            type="button"
            className="settings-server-choice"
            disabled={connection.busy !== null}
            onClick={() => {
              setOpen(false);
              void connection.connect("local");
            }}
          >
            <span className="settings-server-choice-name">
              {t("chrome.connections.local")}
            </span>
            {connection.state?.mode === "local" && <IconCheck size={14} />}
          </button>
          {connection.entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="settings-server-choice"
              disabled={connection.busy !== null}
              onClick={() => {
                setOpen(false);
                void connection.connect(entry);
              }}
            >
              <span className="settings-server-choice-name">
                {connectionLabel(entry)}
              </span>
              <span className="settings-server-choice-url">
                {serverLabel(null, entry.url)}
              </span>
              {connection.currentId === entry.id && <IconCheck size={14} />}
            </button>
          ))}
          {connection.entries.length === 0 && (
            <p className="settings-server-choice-empty">
              {t("chrome.connections.empty")}
            </p>
          )}
        </div>
      )}

      {connection.error !== null && (
        <p className="error-text" role="alert">
          {connection.error}
        </p>
      )}
    </div>
  );
}
