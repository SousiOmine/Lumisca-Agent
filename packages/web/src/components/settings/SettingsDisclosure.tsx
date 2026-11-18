import { IconChevronRight } from "@tabler/icons-preact";
import type { ReactNode } from "preact/compat";
import { useState } from "preact/hooks";

/**
 * A disclosure on a settings page: one row that opens the rest of the page.
 *
 * For a category whose useful part is two rows and whose tuning is nine
 * (models: one model to choose, then every knob behind it), the page is
 * read top to bottom in the order the reader needs it — what runs by
 * default, then what they came to change, then the fine print folded away.
 *
 * Closed is the default: a category that opens with everything shown is the
 * list this replaces. The body stays mounted (`collapse`, see
 * styles/motion.css), so opening is a movement rather than a re-render.
 */
export function SettingsDisclosure({
  label,
  children,
}: {
  /** The word on the row ("詳細"). */
  label: string;
  /** What it opens. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="settings-disclosure">
      <button
        type="button"
        className="settings-disclosure-toggle"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
      >
        <IconChevronRight size={14} />
        <span>{label}</span>
      </button>
      <div className="collapse" data-open={open}>
        <div className="collapse-inner">
          <div className="settings-disclosure-body">{children}</div>
        </div>
      </div>
    </div>
  );
}
