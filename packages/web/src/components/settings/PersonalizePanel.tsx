import { useEffect, useState } from "preact/compat";
import { api } from "../../api.ts";
import { errorText } from "../../providers.ts";
import { useDebouncedWrite, useSavedNotice } from "../../hooks/useSave.ts";
import { useT } from "../../i18n.ts";

/**
 * Settings → カスタマイズ: the machine-level AGENTS.md, which lives next to
 * the settings file and is one of the instruction files a session reads (the
 * workspace's own AGENTS.md chain comes first).
 *
 * The page is the editor: a textarea and a save state. It used to share the
 * category with the saved prompts, which is a different audience — this file
 * is obeyed in both modes, a saved prompt can only be recalled in code mode's
 * composer — so the two now have a page each.
 *
 * The write is debounced while typing rather than waiting for a Save button:
 * the text is a file, and a dialog closed with the caret still in the box
 * must not drop what was typed.
 */
export function PersonalizePanel() {
  const t = useT();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { saved, flash: flashSaved } = useSavedNotice();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getPersonalization()
      .then((info) => setContent(info.content))
      .catch((failure) => setError(errorText(failure)))
      .finally(() => setLoading(false));
  }, []);

  /** Persist the editor's text. The debounced writer supplies the value the
   * user stopped typing on; `content` is read from the argument rather than
   * from a ref so the write and the editor cannot disagree. */
  const persist = async (value: string): Promise<void> => {
    setError(null);
    try {
      await api.putPersonalization(value);
      setSaving(false);
      flashSaved();
    } catch (failure) {
      setSaving(false);
      setError(errorText(failure));
    }
  };
  const pendingWrite = useDebouncedWrite((value: string) => persist(value));

  const onChange = (value: string) => {
    setContent(value);
    setSaving(true);
    setError(null);
    pendingWrite.schedule(value);
  };

  return (
    <div className="settings-pane settings-fill">
      <textarea
        className="personalize-textarea mono"
        value={content}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={t("settings.personalize.customInstructionsPlaceholder")}
        aria-label={t("settings.personalize.customInstructions")}
        spellcheck={false}
        disabled={loading}
      />
      <p className="settings-note">{t("settings.personalize.appliesTo")}</p>
      {error && (
        <p className="error-text" role="alert">
          {t("common.saveFailed", { error })}
        </p>
      )}
      <div className="settings-actions">
        {saving && <span className="settings-note">{t("common.saving")}</span>}
        {!saving && saved && (
          <span className="settings-saved">{t("common.saved")}</span>
        )}
      </div>
    </div>
  );
}
