import { IconChevronDown, IconChevronUp } from "@tabler/icons-preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/compat";
import { useT } from "../i18n.ts";

interface CollapsiblePanelProps {
  /** Row class name; the header/title/detail/summary/body children follow
   * it. */
  kind: string;
  icon: ComponentChildren;
  title: string;
  /** What is happening inside the panel right now (the running task's name,
   * the running command, the goal's text), shown beside the title so the row
   * answers "what is it doing" without being opened. Truncated to one line;
   * the whole value is in its own tooltip. */
  detail?: string;
  /** The right-aligned count (done/total, running processes): a number, not
   * prose, so it keeps its width when the detail ellipsizes. */
  summary: string;
  children: ComponentChildren;
}

/** One row of the progress stack above the composer (todo, goal, tasks,
 * background): a header that toggles the body. Starts collapsed — the stack
 * shares the input area's height with the composer, so an open body would
 * push the field the reader is typing into up the screen. */
export function CollapsiblePanel({
  kind,
  icon,
  title,
  detail,
  summary,
  children,
}: CollapsiblePanelProps) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(true);
  const open = !collapsed;
  return (
    <div className={`${kind}${collapsed ? " collapsed" : ""}`}>
      <button
        type="button"
        className={`${kind}-header`}
        title={
          collapsed ? t("common.expandPanel") : t("panels.common.collapse")
        }
        aria-expanded={open}
        onClick={() => setCollapsed((c) => !c)}
      >
        {icon}
        <span className={`${kind}-title`}>{title}</span>
        {detail !== undefined && (
          // One truncated line; the tooltip carries the rest. It sits on the
          // span, not on the button, so the header's own tooltip keeps
          // saying what a click does.
          <span className={`${kind}-detail`} title={detail}>
            {detail}
          </span>
        )}
        <span className={`${kind}-summary`}>{summary}</span>
        {collapsed ? (
          <IconChevronDown size={14} />
        ) : (
          <IconChevronUp size={14} />
        )}
      </button>
      {/* Always mounted, with `data-open` carrying the state: a body that
       * unmounts cannot animate its height, and the collapse is the whole
       * movement (styles/motion.css, `.collapse`). */}
      <div className="collapse" data-open={open}>
        <div className="collapse-inner">
          <div className={`${kind}-body`}>{children}</div>
        </div>
      </div>
    </div>
  );
}
