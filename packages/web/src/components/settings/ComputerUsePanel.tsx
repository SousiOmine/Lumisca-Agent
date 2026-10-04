import { useState } from "preact/compat";
import { COMPUTER_USE_ENABLED_KEY } from "@lumisca/core/shared";
import { api } from "../../api.ts";
import { errorText } from "../../providers.ts";
import { useAsyncEffect } from "../../hooks/useAsync.ts";
import { useT } from "../../i18n.ts";

/** Settings → セキュリティ: computer use — the agent captures this machine's
 * screen and drives its mouse and keyboard. The feature is opt-in, because
 * a run can then click and type anywhere on the machine.
 *
 * The flag decides which tools a session is given, so the server rebuilds
 * the open sessions when it changes: a change while a session runs is
 * refused (409) and the toggle rolls back to the stored value. A server
 * whose environment cannot offer the feature (Windows only) answers 503 and
 * its message is shown here like any other failure. */
export function ComputerUsePanel() {
  const t = useT();
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useAsyncEffect((isStale) => {
    void api.getSettings()
      .then((settings) => {
        if (isStale()) return;
        setEnabled(settings[COMPUTER_USE_ENABLED_KEY] === "1");
        setLoaded(true);
      })
      .catch((e) => {
        if (!isStale()) setError(errorText(e));
      });
  }, []);

  const setEnabledValue = async (next: boolean) => {
    setSaving(true);
    setError(undefined);
    const previous = enabled;
    setEnabled(next); // optimistic
    try {
      await api.setSetting(COMPUTER_USE_ENABLED_KEY, next ? "1" : "");
    } catch (e) {
      setEnabled(previous);
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-pane">
      <div
        className="update-item"
        title={t("settings.computerUse.tooltip")}
      >
        <div className="update-info">
          <span className="update-label">
            {t("settings.computerUse.title")}
          </span>
          <span className="update-desc">
            {loaded
              ? t("settings.computerUse.description")
              : t("common.loading")}
          </span>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving || !loaded}
            onChange={(e) => setEnabledValue(e.currentTarget.checked)}
            aria-label={t("settings.computerUse.title")}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      {error && (
        <div className="error-text">
          {t("settings.computerUse.operationFailed", { error })}
        </div>
      )}
    </div>
  );
}
