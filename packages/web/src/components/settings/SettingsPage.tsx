import { IconArrowLeft } from "@tabler/icons-preact";
import type { ReactNode } from "preact/compat";
import { useT } from "../../i18n.ts";

/**
 * One settings category as a page: a header that stays put above a body that
 * scrolls.
 *
 * The navigation already names the server or device the page belongs to, so
 * the title does not repeat the owner. A page whose values only code mode's
 * sessions use says so in one line under the title; the rest of the pages
 * carry no scope sentence, because the group above them answers the question.
 *
 * `onBack` is passed by the stepped layout only, where the navigation is a
 * list of its own rather than a column beside the page.
 */
export function SettingsPage({
  title,
  modeOnly = false,
  onBack,
  children,
}: {
  title: ReactNode;
  /** The page's values only code mode's sessions use. */
  modeOnly?: boolean;
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
          <h2>{title}</h2>
          {modeOnly && (
            <p className="settings-page-note">{t("settings.scope.codeOnly")}</p>
          )}
        </div>
      </header>
      <div className="settings-page-body">{children}</div>
    </div>
  );
}
