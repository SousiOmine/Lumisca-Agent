import type { ReactNode } from "preact/compat";
import { IconArrowLeft } from "@tabler/icons-preact";
import { useT } from "../../i18n.ts";

/**
 * The bar of a screen pushed from inside a category: back on the left, the
 * entry's name, then whatever the screen puts on the right (its state badge).
 *
 * These screens used to draw a `modal-header`, which is a DIALOG's title row
 * (`h2`, the dialog's own spacing) — inside a page that now has a header of
 * its own, so the reader saw two title rows with nothing to tell them apart.
 * This bar belongs to the entry rather than to the dialog: a smaller row that
 * starts the page body, and that the entry can describe itself with.
 */
export function SettingsSubHeader({
  onBack,
  title,
  children,
}: {
  onBack: () => void;
  /** The entry this screen is about (a provider's name, a server's). */
  title: ReactNode;
  /** The right end: a state badge, a done button. */
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="settings-subhead">
      <button
        type="button"
        className="settings-subhead-back"
        onClick={onBack}
        title={t("common.back")}
        aria-label={t("common.back")}
      >
        <IconArrowLeft size={15} />
        {t("common.back")}
      </button>
      <span className="settings-subhead-title">{title}</span>
      {children !== undefined && (
        <div className="settings-subhead-actions">{children}</div>
      )}
    </div>
  );
}
