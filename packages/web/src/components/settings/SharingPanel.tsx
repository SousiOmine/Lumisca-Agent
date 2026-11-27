import { errorMessage } from "@lumisca/core/shared";
import { useEffect, useState } from "preact/hooks";
import { useT } from "../../i18n.ts";
import {
  loadShareIdle,
  type ShareIdleSetting,
  saveShareIdle,
  useShareIdle,
} from "../../shareIdle.ts";
import { inDesktopShell } from "../../shell.ts";
import { Select } from "../Select.tsx";
import { SettingRow } from "../SettingRow.tsx";
import { SettingsSection } from "./SettingsSection.tsx";

/** The five choices, in reading order. The value is the wire spelling
 * (see shareIdle.ts), not a number, so the picker and the bridge share one
 * vocabulary. */
const IDLE_VALUES: readonly ShareIdleSetting[] = [
  "5",
  "10",
  "15",
  "30",
  "never",
];

/**
 * Settings → アプリ → フォルダー共有: when a folder lent from this computer
 * is disconnected by itself.
 *
 * The loan is the user's, so its end is the user's choice: a half hour fits
 * looking something up, and a long session that keeps reading the same folder
 * reads as one continuous use anyway. "なし" is for the opposite case: work
 * that pauses longer than any of the lengths while the folder is still
 * wanted.
 *
 * The clock lives in the lending process, not in the page, so this row reads
 * the shell's own setting. A plain browser has no loan to end and no shell to
 * ask, so the section is absent there rather than present and disabled.
 */
export function SharingPanel() {
  const t = useT();
  const idle = useShareIdle();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A browser has no shell to ask; the section is not drawn there either.
    if (inDesktopShell()) loadShareIdle();
  }, []);

  if (!inDesktopShell()) return null;

  const choose = async (next: ShareIdleSetting) => {
    if (busy || next === idle) return;
    setBusy(true);
    setError(null);
    try {
      await saveShareIdle(next);
    } catch (failure) {
      setError(
        t("settings.share.idle.saveFailed", {
          error: errorMessage(failure),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title={t("settings.share.title")}
      description={t("settings.share.description")}
    >
      <SettingRow
        label={t("settings.share.idle.label")}
        description={t("settings.share.idle.description")}
      >
        {idle === null ? (
          <span className="settings-note">{t("common.loading")}</span>
        ) : (
          <Select
            label={t("settings.share.idle.label")}
            value={idle}
            disabled={busy}
            options={IDLE_VALUES.map((value) => ({
              value,
              label:
                value === "never"
                  ? t("settings.share.idle.never")
                  : t("settings.share.idle.minutes", {
                      minutes: Number(value),
                    }),
            }))}
            onChange={(next) => void choose(next)}
          />
        )}
      </SettingRow>
      {idle === "never" && (
        <p className="settings-note">{t("settings.share.idle.neverNote")}</p>
      )}
      {error !== null && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </SettingsSection>
  );
}
