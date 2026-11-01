import type { ReactNode } from "preact/compat";
import { IconArrowLeft } from "@tabler/icons-preact";
import { useT } from "../../i18n.ts";

/**
 * One settings category as a page: a header that stays put (the title, one
 * line saying what the page decides, the way back on a phone) above a body
 * that scrolls.
 *
 * The dialog used to hand the whole body to the panel, so a long category
 * (providers, models) scrolled its own title away: the reader had to go back
 * to the top to learn what the switches in front of them governed, and on a
 * phone to leave the page at all. Here the header is fixed and the body is the
 * only scroller, so the title, the explanation and the way out are always
 * where they were.
 *
 * `onBack` is passed by the stepped layout only, where the navigation is a
 * list of its own rather than a column beside the page.
 */
export function SettingsPage({
  title,
  description,
  onBack,
  children,
}: {
  title: ReactNode;
  /** One line under the title: what this page decides. */
  description?: ReactNode;
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
        <div className="settings-page-titles">
          <h2>{title}</h2>
          {description !== undefined && (
            <p className="settings-page-desc">{description}</p>
          )}
        </div>
      </header>
      <div className="settings-page-body">{children}</div>
    </div>
  );
}
