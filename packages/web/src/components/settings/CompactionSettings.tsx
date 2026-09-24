import { useEffect, useRef, useState } from "preact/compat";
import {
  COMPACTION_DEFAULT_KEEP_RECENT_TOKENS,
  COMPACTION_DEFAULT_RESERVE_TOKENS,
  COMPACTION_ENABLED_KEY,
  COMPACTION_KEEP_RECENT_TOKENS_KEY,
  COMPACTION_RESERVE_TOKENS_KEY,
  parseNonNegativeIntSetting,
} from "@lumisca/core/shared";
import { api } from "../../api.ts";
import { errorText } from "../../providers.ts";
import { useAsyncEffect } from "../../hooks/useAsync.ts";
import { useT } from "../../i18n.ts";

/** Quiet period before a typed token count is persisted (the same
 * debounce the personalization editor uses). */
const SAVE_DEBOUNCE_MS = 600;

/** How long the "saved" note stays visible after a successful write. */
const SAVED_NOTE_MS = 2_000;

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
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [reserve, setReserve] = useState("");
  const [keepRecent, setKeepRecent] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useAsyncEffect((isStale) => {
    void api.getSettings()
      .then((settings) => {
        if (isStale()) return;
        setEnabled(settings[COMPACTION_ENABLED_KEY] !== "0");
        setReserve(settings[COMPACTION_RESERVE_TOKENS_KEY] ?? "");
        setKeepRecent(settings[COMPACTION_KEEP_RECENT_TOKENS_KEY] ?? "");
        setLoaded(true);
      })
      .catch((e) => {
        if (!isStale()) {
          setError(
            t("settings.compaction.saveFailed", { error: errorText(e) }),
          );
        }
      });
  }, []);

  // A pending debounce must not fire after the dialog closed (the write
  // would still be correct, but the state update would be wasted).
  useEffect(() => () => {
    clearTimeout(saveTimer.current);
    clearTimeout(savedTimer.current);
  }, []);

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
      await api.setSetting(key, value);
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), SAVED_NOTE_MS);
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

  /** Commit a token field: an empty value clears the setting (the default
   * applies), anything else must be a whole number of 0 or more. */
  const commitTokens = (
    key: string,
    raw: string,
    current: string,
    apply: (value: string) => void,
  ) => {
    clearTimeout(saveTimer.current);
    const trimmed = raw.trim();
    const parsed = trimmed === ""
      ? undefined
      : parseNonNegativeIntSetting(trimmed);
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
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => commitTokens(key, raw, current, apply),
      SAVE_DEBOUNCE_MS,
    );
  };

  /** One token row (label, description, numeric field). */
  const tokenRow = (
    key: string,
    value: string,
    current: string,
    fallback: number,
    apply: (value: string) => void,
    label: string,
    description: string,
  ) => (
    <div className="update-item">
      <div className="update-info">
        <span className="update-label">{label}</span>
        <span className="update-desc">{description}</span>
      </div>
      <input
        type="text"
        inputMode="numeric"
        className="compaction-token-input"
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
    </div>
  );

  return (
    <div className="settings-pane compaction-settings">
      <span className="update-label">{t("settings.compaction.title")}</span>
      <div className="update-item">
        <div className="update-info">
          <span className="update-label">
            {t("settings.compaction.enabled")}
          </span>
          <span className="update-desc">
            {t("settings.compaction.enabledDesc")}
          </span>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving || !loaded}
            onChange={(e) => toggleEnabled(e.currentTarget.checked)}
            aria-label={t("settings.compaction.enabled")}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      {tokenRow(
        COMPACTION_RESERVE_TOKENS_KEY,
        reserve,
        reserve,
        COMPACTION_DEFAULT_RESERVE_TOKENS,
        setReserve,
        t("settings.compaction.reserveTokens"),
        t("settings.compaction.reserveTokensDesc"),
      )}
      {tokenRow(
        COMPACTION_KEEP_RECENT_TOKENS_KEY,
        keepRecent,
        keepRecent,
        COMPACTION_DEFAULT_KEEP_RECENT_TOKENS,
        setKeepRecent,
        t("settings.compaction.keepRecentTokens"),
        t("settings.compaction.keepRecentTokensDesc"),
      )}

      {saved && !saving && (
        <span className="settings-saved">
          {t("settings.compaction.saved")}
        </span>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
