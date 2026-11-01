import { useEffect, useRef, useState } from "preact/compat";
import {
  COMPACTION_DEFAULT_KEEP_RECENT_PERCENT,
  COMPACTION_DEFAULT_RESERVE_PERCENT,
  COMPACTION_ENABLED_KEY,
  COMPACTION_KEEP_RECENT_PERCENT_KEY,
  COMPACTION_RESERVE_PERCENT_KEY,
  parsePercentSetting,
} from "@lumisca/core/shared";
import { errorText } from "../../providers.ts";
import { useSettings } from "../../settingsStore.ts";
import { useDebouncedWrite, useSavedNotice } from "../../hooks/useSave.ts";
import { useT } from "../../i18n.ts";
import { SettingRow, Toggle } from "../SettingRow.tsx";
import { SettingsSection } from "./SettingsSection.tsx";

/** What one pending token-field commit needs (see typedCommit). */
interface TypedCommit {
  key: string;
  raw: string;
  current: string;
  apply: (value: string) => void;
}

/**
 * Settings → モデル: the context compaction tuning. It follows pi's settings
 * (badlogic/pi-mono): the conversation is condensed once it would come
 * within `reserved tokens` of the model's window, and the newest `kept
 * tokens` stay verbatim (the history itself is never deleted — see
 * core/agent/context-compaction.ts).
 *
 * The values are plain settings read by the session agents on every
 * compaction check, so a change applies to running sessions without a
 * rebuild. An empty field means "use the default", which is what the
 * placeholder shows.
 *
 * The token fields persist while the user types (debounced), not only on
 * blur: a dialog closed with the field still focused must not drop the
 * typed value.
 */
export function CompactionSettings() {
  const t = useT();
  // The settings live in the shared store (read once for the whole page);
  // this panel only owns the text the user is typing.
  const settings = useSettings();
  const loaded = settings.loaded;
  const [enabled, setEnabled] = useState(true);
  const [reserve, setReserve] = useState("");
  const [keepRecent, setKeepRecent] = useState("");
  const { saved, flash: flashSaved } = useSavedNotice();
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  // Seed the fields from the store once it has loaded (it may already be
  // loaded when the dialog opens a second time).
  const seeded = useRef(false);
  useEffect(() => {
    if (!loaded || seeded.current) return;
    seeded.current = true;
    const values = settings.values;
    setEnabled(values[COMPACTION_ENABLED_KEY] !== "0");
    setReserve(values[COMPACTION_RESERVE_PERCENT_KEY] ?? "");
    setKeepRecent(values[COMPACTION_KEEP_RECENT_PERCENT_KEY] ?? "");
  }, [loaded, settings.values]);

  /** One pending piece of typing: which setting, the text, and how to put
   * the field back if the write is refused. The debounced writer owns the
   * timer (and cancels it on unmount); this is only its payload. */
  const typedCommit = useDebouncedWrite<TypedCommit>((commit) => {
    commitTokens(commit.key, commit.raw, commit.current, commit.apply);
  });

  /** Persist one setting; a rejected write restores the previous value so
   * the field never shows something that was not stored. */
  const save = async (
    key: string,
    value: string,
    restore: () => void,
  ): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      await settings.set(key, value);
      flashSaved();
    } catch (e) {
      restore();
      setError(t("settings.compaction.saveFailed", { error: errorText(e) }));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = (next: boolean) => {
    const previous = enabled;
    setEnabled(next); // optimistic, like the other toggles
    void save(
      COMPACTION_ENABLED_KEY,
      next ? "1" : "0",
      () => setEnabled(previous),
    );
  };

  /** Commit a percentage field: an empty value clears the setting (the
   * default applies), anything else must be a whole number in 0-100. */
  const commitTokens = (
    key: string,
    raw: string,
    current: string,
    apply: (value: string) => void,
  ) => {
    typedCommit.cancel();
    const trimmed = raw.trim();
    const parsed = trimmed === "" ? undefined : parsePercentSetting(trimmed);
    if (trimmed !== "" && parsed === undefined) {
      apply(current); // snap back to the stored value
      setError(t("settings.compaction.invalidNumber"));
      return;
    }
    const next = parsed === undefined ? "" : String(parsed);
    if (next === current) return;
    apply(next);
    void save(key, next, () => apply(current));
  };

  /** Typing schedules the commit above; blur and Enter run it immediately,
   * so leaving the field never waits for the timer. */
  const scheduleCommit = (
    key: string,
    raw: string,
    current: string,
    apply: (value: string) => void,
  ) => {
    typedCommit.schedule({ key, raw, current, apply });
  };

  /** One percentage row (label, description, numeric field). */
  const tokenRow = (
    key: string,
    value: string,
    current: string,
    fallback: number,
    apply: (value: string) => void,
    label: string,
    description: string,
  ) => (
    <SettingRow label={label} description={description}>
      <input
        type="text"
        inputMode="numeric"
        className="compaction-percent-input"
        value={value}
        placeholder={String(fallback)}
        disabled={saving || !loaded}
        aria-label={label}
        onChange={(e) => {
          apply(e.currentTarget.value);
          scheduleCommit(key, e.currentTarget.value, current, apply);
        }}
        onBlur={(e) => commitTokens(key, e.currentTarget.value, current, apply)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </SettingRow>
  );

  return (
    <SettingsSection title={t("settings.compaction.title")}>
      <SettingRow
        label={t("settings.compaction.enabled")}
        description={t("settings.compaction.enabledDesc")}
      >
        <Toggle
          checked={enabled}
          disabled={saving || !loaded}
          onChange={toggleEnabled}
          label={t("settings.compaction.enabled")}
        />
      </SettingRow>

      {tokenRow(
        COMPACTION_RESERVE_PERCENT_KEY,
        reserve,
        reserve,
        COMPACTION_DEFAULT_RESERVE_PERCENT,
        setReserve,
        t("settings.compaction.reservePercent"),
        t("settings.compaction.reservePercentDesc"),
      )}
      {tokenRow(
        COMPACTION_KEEP_RECENT_PERCENT_KEY,
        keepRecent,
        keepRecent,
        COMPACTION_DEFAULT_KEEP_RECENT_PERCENT,
        setKeepRecent,
        t("settings.compaction.keepRecentPercent"),
        t("settings.compaction.keepRecentPercentDesc"),
      )}

      {saved && !saving && (
        <span className="settings-saved">
          {t("common.saved")}
        </span>
      )}
      {error && <div className="error-text">{error}</div>}
    </SettingsSection>
  );
}
