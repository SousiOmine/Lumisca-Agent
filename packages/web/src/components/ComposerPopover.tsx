import type { ReactNode } from "preact/compat";

/**
 * The suggestion list both composer popovers draw.
 *
 * `@` (a workspace path) and `/` (a command) open the same control: a
 * surface anchored to the composer, one row per candidate, the active row
 * marked, a status line when there is nothing to offer, and rows that must
 * not take the focus (the caret-based menu closes the moment the textarea
 * loses it).
 *
 * They were drawn separately inside `Composer.tsx`, so the rule "a row keeps
 * the focus in the textarea" was written twice, and the two had already
 * drifted: a mention commits on `mousedown` (the caret must still be where
 * the token was), a command on `click` (its handler moves the caret itself).
 * That difference is real and is now stated in one place instead of looking
 * like an oversight.
 *
 * The row's own markup stays with the caller: a mention row is an icon, a
 * name and a path; a command row is an icon, a label, a description and a
 * submenu chevron.
 */

/** Whether a row commits as soon as the pointer goes down. */
export type PopoverCommit = "mousedown" | "click";

export interface ComposerPopoverProps<T> {
  /** The popover's own class (`.mention-popover`, `.slash-popover`), so each
   * keeps its name in the stylesheet. */
  className: string;
  /** Extra class appended when the surface opens upwards (`.below`). */
  placementClass?: string;
  /** Inline CSS variables for the anchor (the caret position). */
  style?: Record<string, string>;
  items: readonly T[];
  /** The row the keyboard is on. */
  active: number;
  /** Which of the row's events commits it (see {@link PopoverCommit}). */
  commit: PopoverCommit;
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
  /** The row's key (a path, a command id). */
  keyOf: (item: T) => string;
  /** What to draw when `items` is empty. */
  empty: ReactNode;
  /** Extra content above the rows (the slash menu's submenu header). */
  header?: ReactNode;
  /** One row's content, inside the button the list draws. */
  renderRow: (item: T) => ReactNode;
}

export function ComposerPopover<T>({
  className,
  placementClass,
  style,
  items,
  active,
  commit,
  onSelect,
  onHover,
  keyOf,
  empty,
  header,
  renderRow,
}: ComposerPopoverProps<T>) {
  /** The row class: `.mention-popover` → `.mention-item`. */
  const itemClass = `${className.replace("-popover", "")}-item`;
  return (
    <div
      className={placementClass === undefined
        ? className
        : `${className} ${placementClass}`}
      {...(style === undefined ? {} : { style })}
    >
      {header}
      {items.length === 0 ? empty : items.map((item, index) => (
        <button
          key={keyOf(item)}
          type="button"
          className={`${itemClass}${index === active ? " active" : ""}`}
          // Never let a row take the focus: these menus live off the
          // textarea's caret, and a blur closes them before the click
          // lands. This is also why the row takes only one of the two
          // commit events (see `commit`).
          onMouseDown={(e) => {
            e.preventDefault();
            if (commit === "mousedown") onSelect(index);
          }}
          onMouseEnter={() => onHover(index)}
          {...(commit === "click" ? { onClick: () => onSelect(index) } : {})}
        >
          {renderRow(item)}
        </button>
      ))}
    </div>
  );
}
