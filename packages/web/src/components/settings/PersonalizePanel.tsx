import { useEffect, useRef, useState } from "react";
import { api } from "../../api.ts";
import { errorText } from "../../providers.ts";

/** Settings → パーソナライズ. Edits the machine-level AGENTS.md that lives
 * next to the settings file; its content is appended to the end of the
 * system prompt of sessions created after the edit (existing sessions keep
 * their snapshot and are unaffected). Changes save automatically shortly
 * after the user stops typing; there is no explicit save button. */
export function PersonalizePanel() {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Newest typed content; what a save writes, so edits made while a save is
   * in flight are picked up by the next one. */
  const latest = useRef(content);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const info = await api.getPersonalization();
      setContent(info.content);
      latest.current = info.content;
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => {
      clearTimeout(saveTimer.current);
      clearTimeout(savedTimer.current);
    };
  }, []);

  const persist = async () => {
    const value = latest.current;
    setError(null);
    try {
      await api.putPersonalization(value);
      if (latest.current !== value) {
        // More edits arrived while saving; persist the newest again. Keep
        // "保存中..." visible until that save completes.
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => void persist(), 600);
        return;
      }
      setSaving(false);
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setSaving(false);
      setError(errorText(e));
    }
  };

  const onChange = (value: string) => {
    setContent(value);
    latest.current = value;
    setSaved(false);
    setSaving(true);
    setError(null);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void persist(), 600);
  };

  return (
    <div className="settings-pane">
      <p className="settings-note">
        AI へのカスタム指示を設定します。システムプロンプトの最後に付加され、
        <strong>新しく作成するセッションにのみ反映</strong>されます
        (既存のセッションには影響しません)。
      </p>
      <textarea
        className="personalize-textarea mono"
        value={content}
        onChange={(e) => onChange(e.target.value)}
        placeholder="例:\n- 回答は日本語で記述してください。\n- 変更後は必ずテストを実行してください。"
        spellCheck={false}
        disabled={loading}
      />
      {error && <p className="error-text">{error}</p>}
      <div className="settings-actions">
        {saving && <span className="settings-note">保存中...</span>}
        {!saving && saved && (
          <span className="settings-saved">保存しました</span>
        )}
      </div>
    </div>
  );
}
