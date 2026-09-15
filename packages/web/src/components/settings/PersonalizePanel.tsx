import { useEffect, useRef, useState } from "preact/compat";
import {
  IconCheck,
  IconEdit,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-preact";
import { api } from "../../api.ts";
import { errorText } from "../../providers.ts";
import type { SavedPrompt } from "../../types.ts";
import {
  notifySavedPromptsUpdated,
  useSavedPrompts,
} from "../../hooks/useSavedPrompts.ts";
import { useT } from "../../i18n.ts";

/** Settings → パーソナライズ. Edits the machine-level AGENTS.md that lives
 * next to the settings file, and manages saved prompts (user-defined prompt
 * snippets accessible via /prompt). */
export function PersonalizePanel() {
  const t = useT();

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

  const { prompts, error: promptsLoadError, reload: loadPrompts } =
    useSavedPrompts();
  const [editingPrompt, setEditingPrompt] = useState<SavedPrompt | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [promptsError, setPromptsError] = useState<string | null>(null);

  const handleDeletePrompt = async (id: string) => {
    if (!confirm(t("settings.personalize.promptDeleteConfirm", { name: id }))) {
      return;
    }
    try {
      await api.deleteSavedPrompt(id);
      loadPrompts();
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
      loadPrompts();
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
      loadPrompts();
      notifySavedPromptsUpdated();
    } catch (e) {
      setPromptsError(errorText(e));
    }
  };

  return (
    <>
      {/* --- AGENTS.md (custom instructions) --- */}
      <div className="settings-pane" style={{ marginBottom: 24 }}>
        <h3 style={{ margin: "0 0 8px" }}>
          {t("settings.personalize.customInstructions")}
        </h3>
        <textarea
          className="personalize-textarea mono"
          value={content}
          onChange={(e) => onChange(e.currentTarget.value)}
          placeholder={t("settings.personalize.customInstructionsPlaceholder")}
          spellcheck={false}
          disabled={loading}
        />
        {error && <p className="error-text">{error}</p>}
        <div className="settings-actions">
          {saving && (
            <span className="settings-note">
              {t("settings.personalize.saving")}
            </span>
          )}
          {!saving && saved && (
            <span className="settings-saved">
              {t("settings.personalize.saved")}
            </span>
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
          <h3 style={{ margin: 0 }}>
            {t("settings.personalize.savedPrompts")}
          </h3>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setShowAddForm(true);
              setEditingPrompt(null);
            }}
          >
            <IconPlus size={14} /> {t("settings.personalize.add")}
          </button>
        </div>
        <p className="settings-note">
          <code>/prompt</code> {t("settings.personalize.savedPromptsDesc")}
        </p>
        {(promptsError ?? promptsLoadError) && (
          <p className="error-text" role="alert">
            {promptsError ??
              t("settings.personalize.promptsLoadFailed", {
                error: promptsLoadError,
              })}
          </p>
        )}

        {prompts.length === 0 && !showAddForm && (
          <p className="settings-note" style={{ fontStyle: "italic" }}>
            {t("settings.personalize.noPrompts")}
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
                  title={t("settings.personalize.update")}
                >
                  <IconEdit size={13} />
                </button>
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => handleDeletePrompt(p.id)}
                  title={t("common.delete")}
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
  const t = useT();
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
      setError(t("settings.personalize.idEmpty"));
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(trimmedId)) {
      setError(t("settings.personalize.idInvalidChars"));
      return;
    }
    if (!trimmedLabel) {
      setError(t("settings.personalize.displayEmpty"));
      return;
    }
    if (!trimmedPrompt) {
      setError(t("settings.personalize.promptEmpty"));
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
          <span>{t("settings.personalize.idLabel")}</span>
          <input
            placeholder={t("settings.personalize.idPlaceholder")}
            value={id}
            onChange={(e) => setId(e.currentTarget.value)}
            disabled={isEdit}
          />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>{t("settings.personalize.displayLabel")}</span>
          <input
            placeholder={t("settings.personalize.displayPlaceholder")}
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
          />
        </label>
      </div>
      <label className="field">
        <span>{t("settings.personalize.promptLabel")}</span>
        <textarea
          className="mono"
          placeholder={t("settings.personalize.promptPlaceholder")}
          value={prompt}
          onChange={(e) => setPrompt(e.currentTarget.value)}
          rows={4}
          spellcheck={false}
        />
      </label>
      {error && <p className="error-text">{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel}>
          <IconX size={14} /> {t("common.cancel")}
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={handleSubmit}
          disabled={saving}
        >
          <IconCheck size={14} /> {isEdit
            ? t("settings.personalize.update")
            : t("settings.personalize.add")}
        </button>
      </div>
    </div>
  );
}
