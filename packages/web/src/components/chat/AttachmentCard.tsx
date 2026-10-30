import { useState } from "preact/compat";
import { type AttachmentRef, formatAttachmentSize } from "@lumisca/core/shared";
import { useT } from "../../i18n.ts";

/**
 * The files an agent sent with `chat_attach`, drawn under its reply.
 *
 * An image is shown; anything else is a row with its name, its size and a
 * link — the link is the same URL the route serves, with a
 * `Content-Disposition` that makes the browser download it under the name the
 * agent found on disk. Images that fail to load fall back to the download row
 * rather than a broken picture: the file is still there, and the row is the
 * one honest thing to show.
 *
 * `base` is the session's attachment URL prefix (the peer's form when the
 * conversation belongs to a peer). It is a plain string, so the card can be
 * memoized by identity.
 */
export function AttachmentCard({
  attachments,
  base,
}: {
  attachments: readonly AttachmentRef[];
  base: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="attach-card">
      {attachments.map((attachment) => (
        <AttachmentRow
          key={attachment.name}
          attachment={attachment}
          base={base}
        />
      ))}
    </div>
  );
}

function AttachmentRow({
  attachment,
  base,
}: {
  attachment: AttachmentRef;
  base: string;
}) {
  const t = useT();
  // An image that does not decode (a corrupt PNG, a name whose file was
  // deleted) shows the download row instead.
  const [broken, setBroken] = useState(false);
  const url = `${base}${attachment.name}`;

  if (attachment.inline && !broken) {
    return (
      <a
        className="attach-image"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={attachment.displayName}
      >
        <img
          src={url}
          alt={attachment.displayName}
          onError={() => setBroken(true)}
        />
      </a>
    );
  }

  return (
    <a
      className="attach-file"
      href={url}
      download={attachment.displayName}
      target="_blank"
      rel="noopener noreferrer"
    >
      <span className="attach-file-name">{attachment.displayName}</span>
      <span className="attach-file-size">
        {formatAttachmentSize(attachment.size)}
      </span>
      <span className="attach-file-action">{t("chat.attach.download")}</span>
    </a>
  );
}
