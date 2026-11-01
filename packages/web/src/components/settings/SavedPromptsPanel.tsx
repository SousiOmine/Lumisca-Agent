import { useEffect, useRef, useState } from "preact/compat";
import {
  IconCheck,
  IconEdit,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-preact";
import { api } from "../../api.ts";
import { confirmAction } from "../../confirm.ts";
import { errorText } from "../../providers.ts";
import type { SavedPrompt } from "../../types.ts";
import { useSavedPrompts } from "../../hooks/useSavedPrompts.ts";
import { useT } from "../../i18n.ts";
import { Field } from "../Field.tsx";
import { SettingsSection } from "./SettingsSection.tsx";

/**
 * Settings → 保存済みプロンプト: the snippets the composer's `/prompt` menu
 * offers.
 *
 * Its own category because it is code mode's alone: the slash menu lives in
 * the composer, and stella's conversation has one plain box with no commands.
 * It used to sit under the custom instructions (a file both modes obey), so
 * one page held two audiences and the half that did nothing in stella mode was
 * the half with the buttons.
 *
 * A row is what the composer will insert: the ID (how `/prompt`'s menu lists
 * it), the display name, and the text itself. Adding and editing open the same
 * form at the top of the list.
 */
export function SavedPromptsPanel() {
  const t = useT();
  const { prompts, error: loadError, reload } = useSavedPrompts();
  /** undefined = list, null = adding, a prompt = editing it. */
  const [editing, setEditing] = useState<SavedPrompt | null | undefined>(
    undefined,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const startEditing = (prompt: SavedPrompt | null) => {
    setActionError(null);
    setEditing(prompt);
  };

  // The form opens at the top of the list; a reader who scrolled to the
  // bottom to press "Add" must see it, not guess that nothing happened.
  useEffect(() => {
    if (editing === undefined) return;
    formRef.current?.scrollIntoView({ block: "nearest" });
  }, [editing]);

  const remove = async (id: string) => {
    if (!confirmAction(t("settings.prompts.deleteConfirm", { name: id }))) {
      return;
    }
    setActionError(null);
    try {
      await api.deleteSavedPrompt(id);
      // The store re-reads after a mutation, so the composer's menu and this
      // list change together (see hooks/useSavedPrompts.ts).
      reload();
    } catch (failure) {
      setActionError(errorText(failure));
    }
  };

  const save = async (
    input: { id: string; label: string; prompt: string },
  ) => {
    setActionError(null);
    if (editing === null || editing === undefined) {
      await api.createSavedPrompt(input);
    } else {
      await api.updateSavedPrompt(editing.id, {
        label: input.label,
        prompt: input.prompt,
      });
    }
    setEditing(undefined);
    reload();
  };

  return (
    <SettingsSection
      action={
        <button
          type="button"
          className="btn"
          onClick={() => startEditing(null)}
        >
          <IconPlus size={14} /> {t("common.add")}
        </button>
      }
    >
      <p className="settings-note">{t("settings.prompts.description")}</p>

      {(actionError ?? loadError) !== null && (
        <p className="error-text" role="alert">
          {actionError ??
            t("settings.prompts.loadFailed", { error: loadError ?? "" })}
        </p>
      )}

      <div ref={formRef}>
        {editing !== undefined && (
          <PromptForm
            // A key per target: switching from "add" to "edit" must rebuild the
            // fields rather than keep the other entry's text.
            key={editing?.id ?? "new"}
            initial={editing ?? undefined}
            onSave={save}
            onCancel={() => setEditing(undefined)}
          />
        )}
      </div>

      {prompts.length === 0 && editing === undefined && (
        <p className="settings-note">{t("settings.prompts.empty")}</p>
      )}

      {prompts.map((prompt) => (
        <div key={prompt.id} className="saved-prompt-card">
          <div className="saved-prompt-header">
            <code className="saved-prompt-id">{prompt.id}</code>
            <span className="saved-prompt-label">{prompt.label}</span>
            <div className="saved-prompt-actions">
              <button
                type="button"
                className="btn small"
                title={t("common.edit")}
                aria-label={t("common.edit")}
                onClick={() =>
                  startEditing(prompt)}
              >
                <IconEdit size={13} />
              </button>
              <button
                type="button"
                className="btn small danger"
                title={t("common.delete")}
                aria-label={t("common.delete")}
                onClick={() =>
                  void remove(prompt.id)}
              >
                <IconTrash size={13} />
              </button>
            </div>
          </div>
          <pre className="saved-prompt-text">{prompt.prompt}</pre>
        </div>
      ))}
    </SettingsSection>
  );
}

/** The add/edit form: the same fields and validation for both, so only the
 * save target differs. */
function PromptForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: SavedPrompt;
  onSave: (
    input: { id: string; label: string; prompt: string },
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

  const submit = async () => {
    const trimmedId = id.trim();
    const trimmedLabel = label.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedId) return setError(t("settings.prompts.idEmpty"));
    if (!/^[a-zA-Z0-9._-]+$/.test(trimmedId)) {
      return setError(t("settings.prompts.idInvalidChars"));
    }
    if (!trimmedLabel) return setError(t("settings.prompts.displayEmpty"));
    if (!trimmedPrompt) return setError(t("settings.prompts.promptEmpty"));

    setError(null);
    setSaving(true);
    try {
      await onSave({
        id: trimmedId,
        label: trimmedLabel,
        prompt: trimmedPrompt,
      });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="saved-prompt-form">
      <div className="saved-prompt-form-row">
        <Field label={t("settings.prompts.idLabel")} style={{ flex: 1 }}>
          <input
            placeholder={t("settings.prompts.idPlaceholder")}
            value={id}
            onChange={(e) => setId(e.currentTarget.value)}
            disabled={isEdit}
          />
        </Field>
        <Field label={t("settings.prompts.displayLabel")} style={{ flex: 1 }}>
          <input
            placeholder={t("settings.prompts.displayPlaceholder")}
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
          />
        </Field>
      </div>
      <Field label={t("settings.prompts.promptLabel")}>
        <textarea
          className="mono"
          placeholder={t("settings.prompts.promptPlaceholder")}
          value={prompt}
          onChange={(e) => setPrompt(e.currentTarget.value)}
          rows={4}
          spellcheck={false}
        />
      </Field>
      {error && <p className="error-text">{error}</p>}
      <div className="settings-actions settings-actions-end">
        <button type="button" className="btn" onClick={onCancel}>
          <IconX size={14} /> {t("common.cancel")}
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={submit}
          disabled={saving}
        >
          <IconCheck size={14} />{" "}
          {isEdit ? t("common.update") : t("common.add")}
        </button>
      </div>
    </div>
  );
}
