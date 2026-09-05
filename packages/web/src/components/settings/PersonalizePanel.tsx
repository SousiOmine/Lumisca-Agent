import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconCheck,
  IconEdit,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { api } from "../../api.ts";
import { errorText } from "../../providers.ts";
import type { SavedPrompt } from "../../types.ts";
import { notifySavedPromptsUpdated } from "../../hooks/useSavedPrompts.ts";

/** Settings → パーソナライズ. Edits the machine-level AGENTS.md that lives
 * next to the settings file, and manages saved prompts (user-defined prompt
 * snippets accessible via /prompt). */
export function PersonalizePanel() {
  // --- AGENTS.md editors -------------------------------------------------

  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  // --- Saved prompts -----------------------------------------------------

  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [promptsError, setPromptsError] = useState<string | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<SavedPrompt | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const loadPrompts = useCallback(async () => {
    setPromptsLoading(true);
    setPromptsError(null);
    try {
      const result = await api.getSavedPrompts();
      setPrompts(result.prompts);
    } catch (e) {
      setPromptsError(errorText(e));
    } finally {
      setPromptsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPrompts();
  }, [loadPrompts]);

  const handleDeletePrompt = async (id: string) => {
    if (!confirm(`プロンプト "${id}" を削除しますか？`)) return;
    try {
      await api.deleteSavedPrompt(id);
      await loadPrompts();
      notifySavedPromptsUpdated();
    } catch (e) {
      setPromptsError(errorText(e));
    }
  };

  const handleAddPrompt = async (input: {
    id?: string;
    label: string;
    prompt: string;
  }) => {
    try {
      await api.createSavedPrompt(
        input as { id: string; label: string; prompt: string },
      );
      setShowAddForm(false);
      await loadPrompts();
      notifySavedPromptsUpdated();
    } catch (e) {
      setPromptsError(errorText(e));
    }
  };

  const handleUpdatePrompt = async (
    id: string,
    input: { label?: string; prompt?: string },
  ) => {
    try {
      await api.updateSavedPrompt(id, input);
      setEditingPrompt(null);
      await loadPrompts();
      notifySavedPromptsUpdated();
    } catch (e) {
      setPromptsError(errorText(e));
    }
  };

  return (
    <>
      {/* --- AGENTS.md (custom instructions) --- */}
      <div className="settings-pane" style={{ marginBottom: 24 }}>
        <h3 style={{ margin: "0 0 8px" }}>カスタム指示 (AGENTS.md)</h3>
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

      {/* --- Saved prompts --- */}
      <div className="settings-pane">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <h3 style={{ margin: 0 }}>保存済みプロンプト</h3>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setShowAddForm(true);
              setEditingPrompt(null);
            }}
          >
            <IconPlus size={14} /> 追加
          </button>
        </div>
        <p className="settings-note">
          スラッシュコマンド <code>/prompt</code>{" "}
          から呼び出せるプロンプト
          スニペットを登録します。識別子は英数字で入力してください。
        </p>

        {promptsError && <p className="error-text">{promptsError}</p>}

        {promptsLoading && prompts.length === 0 && (
          <p className="settings-note">読み込み中...</p>
        )}

        {!promptsLoading && prompts.length === 0 && !showAddForm && (
          <p className="settings-note" style={{ fontStyle: "italic" }}>
            保存済みプロンプトはまだありません。「追加」ボタンから追加してください。
          </p>
        )}

        {/* Add form */}
        {showAddForm && (
          <PromptEditForm
            onSave={handleAddPrompt}
            onCancel={() => setShowAddForm(false)}
          />
        )}

        {/* Edit form */}
        {editingPrompt && (
          <PromptEditForm
            initial={editingPrompt}
            onSave={(input) => handleUpdatePrompt(editingPrompt.id, input)}
            onCancel={() => setEditingPrompt(null)}
          />
        )}

        {/* Prompt list */}
        {prompts.map((p) => (
          <div key={p.id} className="saved-prompt-card">
            <div className="saved-prompt-header">
              <strong className="saved-prompt-id">{p.id}</strong>
              <span className="saved-prompt-label">{p.label}</span>
              <div className="saved-prompt-actions">
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    setEditingPrompt(p);
                    setShowAddForm(false);
                  }}
                  title="編集"
                >
                  <IconEdit size={13} />
                </button>
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => handleDeletePrompt(p.id)}
                  title="削除"
                >
                  <IconTrash size={13} />
                </button>
              </div>
            </div>
            <pre className="saved-prompt-text">{p.prompt}</pre>
          </div>
        ))}
      </div>
    </>
  );
}

// --- Prompt edit/add form ---------------------------------------------------

function PromptEditForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: SavedPrompt;
  onSave: (
    input: { id: string; label: string; prompt: string } | {
      label: string;
      prompt: string;
    },
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = initial !== undefined;

  const handleSubmit = async () => {
    setError(null);
    const trimmedId = id.trim();
    const trimmedLabel = label.trim();
    const trimmedPrompt = prompt.trim();

    if (!trimmedId) {
      setError("識別子を入力してください");
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(trimmedId)) {
      setError(
        "識別子は英数字・. _ - のみ使用できます",
      );
      return;
    }
    if (!trimmedLabel) {
      setError("表示名を入力してください");
      return;
    }
    if (!trimmedPrompt) {
      setError("プロンプト文を入力してください");
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        await onSave({ label: trimmedLabel, prompt: trimmedPrompt });
      } else {
        await onSave({
          id: trimmedId,
          label: trimmedLabel,
          prompt: trimmedPrompt,
        });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="saved-prompt-form">
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <label className="field" style={{ flex: 1 }}>
          <span>識別子</span>
          <input
            placeholder="例: translate"
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={isEdit}
          />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>表示名</span>
          <input
            placeholder="例: 翻訳"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
      </div>
      <label className="field">
        <span>プロンプト文</span>
        <textarea
          className="mono"
          placeholder="例: 次のテキストを日本語に翻訳してください:\n\n{ここにテキスト}"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          spellCheck={false}
        />
      </label>
      {error && <p className="error-text">{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel}>
          <IconX size={14} /> キャンセル
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={handleSubmit}
          disabled={saving}
        >
          <IconCheck size={14} /> {isEdit ? "更新" : "追加"}
        </button>
      </div>
    </div>
  );
}
