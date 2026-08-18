import { useEffect, useState } from "react";
import {
  COMMAND_SAFETY_ENABLED_KEY,
  FAST_MODEL_KEY,
  parseModelPreference,
} from "@lumisca/core/shared";
import type { CommandApproval } from "@lumisca/core/shared";
import { api } from "../../api.ts";
import { errorText } from "../../providers.ts";

/** Settings → セキュリティ: the command safety check. When enabled, the
 * fast model judges every bash / eval / async_bash command before it runs;
 * commands judged safe are recorded and skip the check afterwards. Commands
 * the check cannot judge (no fast model, errors, timeouts) are blocked too. */
export function CommandSafetyPanel() {
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [fastModelSet, setFastModelSet] = useState(true);
  const [approvals, setApprovals] = useState<CommandApproval[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let stale = false;
    api.getSettings()
      .then((settings) => {
        if (stale) return;
        setEnabled(settings[COMMAND_SAFETY_ENABLED_KEY] === "1");
        setFastModelSet(
          parseModelPreference(settings[FAST_MODEL_KEY]) !== undefined,
        );
        setLoaded(true);
      })
      .catch((e) => {
        if (!stale) setError(errorText(e));
      });
    api.getCommandSafety()
      .then((state) => {
        if (!stale) setApprovals(state.approvals);
      })
      .catch((e) => {
        if (!stale) setError(errorText(e));
      });
    return () => {
      stale = true;
    };
  }, []);

  const setEnabledValue = async (next: boolean) => {
    setSaving(true);
    setError(undefined);
    const previous = enabled;
    setEnabled(next); // optimistic
    try {
      await api.setSetting(COMMAND_SAFETY_ENABLED_KEY, next ? "1" : "");
    } catch (e) {
      setEnabled(previous);
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const removeApproval = async (hash: string) => {
    setSaving(true);
    setError(undefined);
    try {
      await api.deleteCommandApproval(hash);
      setApprovals((prev) => prev.filter((a) => a.hash !== hash));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const clearApprovals = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await api.clearCommandApprovals();
      setApprovals([]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-pane">
      <p className="settings-note">
        bash / eval の実行前に、高速モデルがコマンドの安全性を自動判定します。
        安全と判定されたコマンドは承認リストに記録され、次回からは判定なしで
        実行されます。危険と判定されたコマンドのほか、判定できなかった
        コマンド（判定が失敗・タイムアウトした場合）も実行されず、停止理由が
        エージェントに返されます。
      </p>

      <div className="update-item">
        <div className="update-info">
          <span className="update-label">コマンド安全チェック</span>
          <span className="update-desc">
            bash / eval / async_bash を実行するたびに高速モデルで判定します。
          </span>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(e) => setEnabledValue(e.target.checked)}
            aria-label="コマンド安全チェック"
          />
          <span className="toggle-slider" />
        </label>
      </div>

      {!fastModelSet && (
        <p className="settings-warning">
          高速モデルが未設定のため、チェックを有効にすると判定できないコマンドが
          すべてブロックされます。「モデル」の「高速モデル」から設定してください。
        </p>
      )}

      <div className="approval-section">
        <div className="approval-header">
          <span className="approval-title">承認済みコマンド</span>
          {approvals.length > 0 && (
            <button
              type="button"
              className="btn small"
              disabled={saving}
              onClick={clearApprovals}
            >
              すべて削除
            </button>
          )}
        </div>
        {approvals.length === 0
          ? (
            <p className="settings-note">
              {loaded ? "承認済みのコマンドはありません。" : "読み込み中..."}
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
                    aria-label="承認を削除"
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>

      {error && <div className="error-text">操作に失敗しました: {error}</div>}
    </div>
  );
}
