import { serverLabel } from "../../connections.ts";
import type { ConnectionSwitch } from "../../hooks/useConnectionSwitch.ts";
import { useT } from "../../i18n.ts";

/**
 * The head of the settings navigation's server group: which server the pages
 * below belong to.
 *
 * Switching the displayed server is the title bar's job (ConnectionPicker),
 * and the connections page is its own entry in the navigation. A switch and a
 * "manage" link here would be two more answers to one question.
 *
 * The heading is text, not a card: the navigation is a list of pages, and a
 * filled box around its owner made the group look like one more page.
 */
export function ServerHeading({
  connection,
}: {
  connection: ConnectionSwitch;
}) {
  const t = useT();
  const label = connection.currentLabel();
  // The page URL carries the auth token in its query; serverLabel keeps the
  // host and drops the rest, which is the part a reader recognises.
  const address = connection.state?.url
    ? serverLabel(null, connection.state.url)
    : null;

  return (
    <div className="settings-server-head">
      <div className="settings-server-headtext">
        <h3 className="settings-server-name" title={label}>
          {label}
        </h3>
        {connection.desktop ? (
          address !== null && address !== label ? (
            <span className="settings-server-address">{address}</span>
          ) : null
        ) : (
          <span className="settings-server-note">
            {t("settings.serverCard.browser")}
          </span>
        )}
      </div>
    </div>
  );
}
