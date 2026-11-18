import type { PushControls } from "../../hooks/usePush.ts";
import type { UpdateSource } from "../../hooks/useUpdateStatus.ts";
import { useT } from "../../i18n.ts";
import { inDesktopShell } from "../../shell.ts";
import { SettingRow, Toggle } from "../SettingRow.tsx";

function PushNotificationsItem({ push }: { push: PushControls }) {
  const t = useT();
  if (push.state === "unsupported") return null;
  return (
    <>
      <SettingRow
        label={t("settings.general.pushNotifications")}
        description={t("settings.general.pushNotificationsDesc")}
      >
        <Toggle
          checked={push.state === "on"}
          disabled={push.state === "busy" || push.state === "denied"}
          onChange={push.toggle}
          label={t("settings.general.pushNotifications")}
        />
      </SettingRow>
      {push.state === "denied" && (
        <p className="settings-note" role="alert">
          {t("settings.general.pushDenied")}
        </p>
      )}
      {push.state === "on" && (
        <div className="update-status-row">
          <span className="update-status-text">
            {push.tested ? t("settings.general.pushTestSent") : ""}
          </span>
          <div className="update-actions">
            <button type="button" className="btn small" onClick={push.sendTest}>
              {t("settings.general.pushTest")}
            </button>
          </div>
        </div>
      )}
      {push.error !== null && (
        <p className="error-text" role="alert">
          {t("settings.general.pushFailed", { error: push.error })}
        </p>
      )}
    </>
  );
}

/**
 * Settings → 通知: the channels this device receives, not the server's
 * settings. The desktop toggle is the shell notifying the window the app runs
 * in; the push row is the browser's push service reaching every device the
 * app was installed on. The row disappears where the channel cannot exist (an
 * insecure origin, the desktop shell's loopback page, a browser without the
 * Push API): a switch the reader cannot use and a reason they did not ask for
 * is worse than no row at all.
 */
export function NotificationsPanel({
  source,
  notifyEnabled,
  onNotifyEnabledChange,
  push,
}: {
  /** "shell" is the only source that can deliver the desktop notification:
   * the same browser page has no desktop window to notify. */
  source: UpdateSource | null;
  notifyEnabled: boolean;
  onNotifyEnabledChange: (enabled: boolean) => void;
  push: PushControls;
}) {
  const t = useT();
  const pushAvailable = push.state !== "unsupported";
  return (
    <div className="settings-pane">
      {source === "shell" && (
        <SettingRow label={t("settings.general.bgNotification")}>
          <Toggle
            checked={notifyEnabled}
            onChange={onNotifyEnabledChange}
            label={t("settings.general.bgNotification")}
          />
        </SettingRow>
      )}
      <PushNotificationsItem push={push} />
      {!inDesktopShell() && !pushAvailable && (
        <p className="settings-note">{t("settings.notifications.none")}</p>
      )}
    </div>
  );
}
