import type { AttachmentRef } from "@lumisca/core/shared";
import {
  type AttachmentView,
  MessageAttachments,
} from "./MessageAttachments.tsx";

/**
 * The files an agent sent with `chat_attach` or `send_chat`, drawn under
 * its reply with the same block the reader's own attachments use.
 *
 * A picture is a tile that opens the original in the app; anything else is a
 * card that downloads it. `base` is the session's attachment URL prefix,
 * which is a plain string so the card can be memoized by identity.
 */
export function AttachmentCard({
  attachments,
  base,
}: {
  attachments: readonly AttachmentRef[];
  base: string;
}) {
  if (attachments.length === 0) return null;
  const items: AttachmentView[] = attachments.map((attachment) =>
    attachment.inline
      ? {
          key: attachment.name,
          kind: "image",
          name: attachment.displayName,
          src: `${base}${attachment.name}`,
          fullSrc: `${base}${attachment.name}?preview=0`,
        }
      : {
          key: attachment.name,
          kind: "file",
          name: attachment.displayName,
          size: attachment.size,
          href: `${base}${attachment.name}`,
          downloadName: attachment.displayName,
        },
  );
  return <MessageAttachments items={items} className="agent" />;
}
