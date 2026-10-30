import { useState } from "preact/compat";
import {
  COMMAND_SAFETY_ENABLED_KEY,
  FAST_MODEL_KEY,
  parseModelPreference,
} from "@lumisca/core/shared";
import type { CommandApproval } from "@lumisca/core/shared";
import { api } from "../../api.ts";
import { errorText } from "../../providers.ts";
import { useAsyncEffect } from "../../hooks/useAsync.ts";
import { useSaveAction } from "../../hooks/useSave.ts";
import { useT } from "../../i18n.ts";

/** Settings → セキュリティ: the command safety check. When enabled, the
 * fast model judges every bash / eval / async_bash command before it runs;
 * commands judged safe are recorded and skip the check afterwards. Commands
 * the check cannot judge (no fast model, errors, timeouts) are blocked too. */
export function CommandSafetyPanel() {
  const t = useT();
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [fastModelSet, setFastModelSet] = useState(true);
  const [approvals, setApprovals] = useState<CommandApproval[]>([]);
  const { saving, error, save, fail } = useSaveAction(errorText);

  // The two loads are independent: fire both at once like before, with the
  // shared stale guard instead of a local flag.
  useAsyncEffect((isStale) => {
    void api.getSettings()
      .then((settings) => {
        if (isStale()) return;
        setEnabled(settings[COMMAND_SAFETY_ENABLED_KEY] === "1");
        setFastModelSet(
          parseModelPreference(settings[FAST_MODEL_KEY]) !== undefined,
        );
        setLoaded(true);
      })
      .catch((e) => {
        if (!isStale()) fail(e);
      });
    void api.getCommandSafety()
      .then((state) => {
        if (!isStale()) setApprovals(state.approvals);
      })
      .catch((e) => {
        if (!isStale()) fail(e);
      });
  }, []);

  const setEnabledValue = (next: boolean) => {
    const previous = enabled;
    setEnabled(next); // optimistic
    void save(
      () => api.setSetting(COMMAND_SAFETY_ENABLED_KEY, next ? "1" : ""),
      () => setEnabled(previous),
    );
  };

  const removeApproval = (hash: string) =>
    save(async () => {
      await api.deleteCommandApproval(hash);
      setApprovals((prev) => prev.filter((a) => a.hash !== hash));
    });

  const clearApprovals = () =>
    save(async () => {
      await api.clearCommandApprovals();
      setApprovals([]);
    });

  return (
    <div className="settings-pane">
      <div
        className="update-item"
        title={t("settings.security.tooltip")}
      >
        <div className="update-info">
          <span className="update-label">{t("settings.security.title")}</span>
          <span className="update-desc">
            {t("settings.security.description")}
          </span>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(e) => setEnabledValue(e.currentTarget.checked)}
            aria-label={t("settings.security.title")}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      {!fastModelSet && (
        <p className="settings-warning">
          {t("settings.security.fastModelMissing")}
        </p>
      )}

      <div className="approval-section">
        <div className="approval-header">
          <span className="approval-title">
            {t("settings.security.approvedCommands")}
          </span>
          {approvals.length > 0 && (
            <button
              type="button"
              className="btn small"
              disabled={saving}
              onClick={clearApprovals}
            >
              {t("settings.security.deleteAll")}
            </button>
          )}
        </div>
        {approvals.length === 0
          ? (
            <p className="settings-note">
              {loaded
                ? t("settings.security.approvedNone")
                : t("common.loading")}
            </p>
          )
          : (
            <ul className="approval-list">
              {approvals.map((entry) => (
                <li key={entry.hash} className="approval-item">
                  <div className="approval-body">
                    <code className="approval-command">{entry.command}</code>
                    <span className="approval-meta">
                      {entry.kind} · {entry.cwd}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn small"
                    disabled={saving}
                    onClick={() =>
                      removeApproval(entry.hash)}
                    aria-label={t("settings.security.deleteApprovalAria")}
                  >
                    {t("common.delete")}
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>

      {error && (
        <div className="error-text">
          {t("settings.security.operationFailed", { error })}
        </div>
      )}
    </div>
  );
}
