import { useEffect, useState } from "react";
import { api } from "../../api.ts";

/** Settings → パーソナライズ. Edits the machine-level AGENTS.md that lives
 * next to the settings file; its content is appended to the end of the
 * system prompt of sessions created after the edit (existing sessions keep
 * their snapshot and are unaffected). */
export function PersonalizePanel() {
  const [content, setContent] = useState("");
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const info = await api.getPersonalization();
      setContent(info.content);
      setPath(info.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const info = await api.putPersonalization(content);
      setPath(info.path);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-pane">
      <p className="settings-note">
        AI へのカスタム指示を設定します。システムプロンプトの最後に付加され、
        <strong>新しく作成するセッションにのみ反映</strong>されます
        (既存のセッションには影響しません)。
      </p>
      {path && <p className="settings-note">保存先: {path}</p>}
      <textarea
        className="personalize-textarea mono"
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          setSaved(false);
        }}
        placeholder="例:\n- 回答は日本語で記述してください。\n- 変更後は必ずテストを実行してください。"
        spellCheck={false}
        disabled={loading}
      />
      {error && <p className="error-text">{error}</p>}
      <div className="settings-actions">
        <button
          type="button"
          className="btn primary"
          onClick={save}
          disabled={loading || saving}
        >
          {saving ? "保存中..." : "保存"}
        </button>
        {saved && <span className="settings-saved">保存しました</span>}
      </div>
    </div>
  );
}
