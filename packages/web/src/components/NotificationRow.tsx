import { useState } from "react";
import {
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconRefresh,
  IconSend,
  IconTerminal2,
} from "@tabler/icons-react";
import type { NotificationMessage } from "../types.ts";

/** Icon for the notification kind. */
function kindIcon(kind: NotificationMessage["kind"]) {
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

/** A system notification (background command completion, sub-agent task
 * completion, agent message) rendered as a compact one-line row like a tool
 * call — never as a user message. The detail body (output tail / task
 * result / message text) expands on click. */
export function NotificationRow({ message }: { message: NotificationMessage }) {
  const [open, setOpen] = useState(false);
  const expandable = message.body.length > 0;

  return (
    <div className="notification-timeline">
      <div
        className={`notification-line${open ? " open" : ""}${
          expandable ? "" : " static"
        }`}
        onClick={() => {
          if (expandable) setOpen((o) => !o);
        }}
      >
        {expandable && (
          <span className="notification-line-chevron">
            <IconChevronRight size={12} />
          </span>
        )}
        <span className="notification-line-icon">
          {kindIcon(message.kind)}
        </span>
        <span className="notification-line-summary">
          {displayTitle(message.title)}
        </span>
        {message.status === "success" && (
          <IconCheck size={12} className="notification-line-check" />
        )}
        {message.status === "error" && (
          <span className="notification-line-error">error</span>
        )}
      </div>
      {open && (
        <div className="notification-detail">
          <div className="notification-detail-body">
            <pre>{message.body}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
