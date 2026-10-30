import { useState } from "preact/compat";
import type { ComponentChildren } from "preact";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-preact";
import { useT } from "../i18n.ts";
import { useNarrowViewport } from "../hooks/useMediaQuery.ts";

interface CollapsiblePanelProps {
  /** Card class name; the header/title/summary/body children follow it. */
  kind: string;
  icon: ComponentChildren;
  title: string;
  summary: string;
  children: ComponentChildren;
}

/** One card of the top-right progress stack (todo, goal, tasks, background):
 * a header that toggles the body. Starts collapsed at phone width, where the
 * stack sits above the transcript and an open body would cover most of what
 * it describes. */
export function CollapsiblePanel(
  { kind, icon, title, summary, children }: CollapsiblePanelProps,
) {
  const t = useT();
  const narrow = useNarrowViewport();
  const [collapsed, setCollapsed] = useState(narrow);
  return (
    <div className={`${kind}${collapsed ? " collapsed" : ""}`}>
      <button
        type="button"
        className={`${kind}-header`}
        title={collapsed
          ? t("common.expandPanel")
          : t("panels.common.collapse")}
        onClick={() => setCollapsed((c) => !c)}
      >
        {icon}
        <span className={`${kind}-title`}>{title}</span>
        <span className={`${kind}-summary`}>{summary}</span>
        {collapsed
          ? <IconChevronDown size={14} />
          : <IconChevronUp size={14} />}
      </button>
      {!collapsed && <div className={`${kind}-body`}>{children}</div>}
    </div>
  );
}
