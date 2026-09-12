import type { ComponentChildren } from "preact";
import {
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconRefresh,
  IconSend,
  IconTerminal2,
} from "@tabler/icons-preact";
import type { NotificationKind, NotificationStatus } from "../types.ts";
import { useExpandableRow } from "../hooks/useExpandableRow.ts";

/** Icon for a notification kind. */
export function notificationKindIcon(kind: NotificationKind) {
  switch (kind) {
    case "background":
      return <IconTerminal2 size={13} />;
    case "task":
      return <IconBrain size={13} />;
    case "message":
      return <IconSend size={13} />;
    case "retry":
      return <IconRefresh size={13} />;
  }
}

/** The title with its outer "[...]" head brackets dropped for display. */
function displayTitle(title: string): string {
  return title.startsWith("[") && title.endsWith("]")
    ? title.slice(1, -1)
    : title;
}

/**
 * One injected system row (a notification or a dynamic-context snapshot):
 * a compact one-line row like a tool call — never a user message — whose
 * body (output tail / task report / context text) expands on click.
 */
export function SystemRow({
  title,
  body,
  status,
  icon,
}: {
  title: string;
  body: string;
  status: NotificationStatus;
  icon: ComponentChildren;
}) {
  const expandable = body.length > 0;
  const { open, triggerProps } = useExpandableRow(expandable);

  return (
    <div className="notification-timeline">
      <div
        className={`notification-line${open ? " open" : ""}${
          expandable ? "" : " static"
        }`}
        {...triggerProps}
      >
        {expandable && (
          <span className="notification-line-chevron">
            <IconChevronRight size={12} />
          </span>
        )}
        <span className="notification-line-icon">{icon}</span>
        <span className="notification-line-summary">{displayTitle(title)}</span>
        {status === "success" && (
          <IconCheck size={12} className="notification-line-check" />
        )}
        {status === "error" && (
          <span className="notification-line-error">error</span>
        )}
      </div>
      {open && (
        <div className="notification-detail">
          <div className="notification-detail-body">
            <pre>{body}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
