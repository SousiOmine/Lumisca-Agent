import type { NotificationMessage } from "../types.ts";
import { notificationKindIcon, SystemRow } from "./SystemRow.tsx";

/** A system notification (background command completion, sub-agent task
 * completion, agent message, retry) rendered as a compact one-line row. */
export function NotificationRow({ message }: { message: NotificationMessage }) {
  return (
    <SystemRow
      title={message.title}
      body={message.body}
      status={message.status}
      icon={notificationKindIcon(message.kind)}
    />
  );
}
