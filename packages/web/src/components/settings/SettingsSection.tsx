import type { ReactNode } from "preact/compat";

/**
 * One section inside a settings category: an optional heading with its own
 * action on the right, an optional explanation, and the items it lists.
 *
 * The heading is omitted for a category whose body IS one list (saved
 * prompts, the saved-commands registry): the page's own title (SettingsPage)
 * already names it, and repeating it one line lower is noise. A category
 * holding several groups (providers, models, general) names each of them, so
 * a reader always knows which of the things below the heading they are
 * looking at.
 *
 * The heading is an `h3`: the category's title is the `h2` of the screen.
 */
export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  /** Group heading; omitted when the page holds a single list. */
  title?: ReactNode;
  description?: ReactNode;
  /** The section's own action (typically "add"), at the heading's right. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const head = title !== undefined || action !== undefined;
  return (
    <section className="settings-section">
      {head && (
        <div className="settings-section-head">
          {title !== undefined && <h3>{title}</h3>}
          {action}
        </div>
      )}
      {description !== undefined && (
        <p className="settings-note">{description}</p>
      )}
      <div className="settings-list">{children}</div>
    </section>
  );
}
