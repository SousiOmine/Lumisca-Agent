import { IconArrowLeft } from "@tabler/icons-preact";
import type { ReactNode } from "preact/compat";
import { useT } from "../../i18n.ts";

/**
 * One settings category as a page: a header that stays put (the title, the
 * owner, the one sentence about what the page acts on, and the way back on a
 * phone) above a body that scrolls.
 *
 * The header used to be the title alone. A long category scrolled its own
 * title away, so the reader had to go back to the top to learn which category
 * the switches belonged to; nothing said which machine either. The owner
 * badge is now part of the header, and the scope sentence sits under the
 * title where it is read before the first row, not after the last one.
 *
 * `onBack` is passed by the stepped layout only, where the navigation is a
 * list of its own rather than a column beside the page.
 */
export function SettingsPage({
  title,
  ownerLabel,
  modeOnly = false,
  scope,
  onBack,
  children,
}: {
  title: ReactNode;
  /** The machine or device the page's values belong to. */
  ownerLabel?: ReactNode;
  /** The page's values only code mode's sessions use. */
  modeOnly?: boolean;
  /** What the page's values act on, in one sentence. */
  scope?: ReactNode;
  /** Return to the category list (stepped layout only). */
  onBack?: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="settings-page">
      <header className="settings-page-head">
        {onBack !== undefined && (
          <button
            type="button"
            className="settings-page-back"
            onClick={onBack}
            title={t("common.back")}
            aria-label={t("common.back")}
          >
            <IconArrowLeft size={16} />
          </button>
        )}
        <div className="settings-page-headtext">
          <div className="settings-page-titlerow">
            <h2>{title}</h2>
            {ownerLabel !== undefined && (
              <span className="settings-owner-badge">{ownerLabel}</span>
            )}
            {modeOnly && (
              <span className="settings-mode-badge">
                {t("settings.scope.codeOnly")}
              </span>
            )}
          </div>
          {scope !== undefined && (
            <p className="settings-page-scope">{scope}</p>
          )}
        </div>
      </header>
      <div className="settings-page-body">{children}</div>
    </div>
  );
}
