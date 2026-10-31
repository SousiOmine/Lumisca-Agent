import type { ReactNode } from "preact/compat";

/**
 * One section of a settings category: a heading with its own action on the
 * right, an optional explanation, and the rows it lists.
 *
 * The プロバイダー category holds two lists of the same kind (the AI
 * providers whose keys make the agent think, and the search providers whose
 * keys let it look things up). They used to be two different screens on one
 * page — a stack of full-width buttons for one, cards with actions for the
 * other, the add button at the top of one and at the bottom of the other —
 * so a reader had to re-learn the layout halfway down. Both are now this
 * shape: heading + add, a one-line explanation, then rows.
 */
export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** The section's own action (typically "add"), at the heading's right. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2>{title}</h2>
        {action}
      </div>
      {description !== undefined && (
        <p className="settings-note">{description}</p>
      )}
      <div className="settings-list">{children}</div>
    </section>
  );
}
