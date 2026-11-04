import { useState } from "preact/compat";
import { type AttachmentRef, formatAttachmentSize } from "@lumisca/core/shared";
import { useT } from "../../i18n.ts";
import { Lightbox } from "../Lightbox.tsx";

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
  /** The picture the reader opened, or null. Shared by the card rather than
   * held by each row: opening one is a property of the card (one picture at a
   * time), and the row unmounts when the message scrolls out of the window. */
  const [open, setOpen] = useState<AttachmentRef | null>(null);
  if (attachments.length === 0) return null;
  return (
    <div className="attach-card">
      {attachments.map((attachment) => (
        <AttachmentRow
          key={attachment.name}
          attachment={attachment}
          base={base}
          onOpen={() => setOpen(attachment)}
        />
      ))}
      {open !== null && (
        <Lightbox
          // `preview=0` is the original: the point of opening it is to see
          // what the thumbnail could not show.
          src={`${base}${open.name}?preview=0`}
          alt={open.displayName}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function AttachmentRow({
  attachment,
  base,
  onOpen,
}: {
  attachment: AttachmentRef;
  base: string;
  onOpen: () => void;
}) {
  const t = useT();
  // An image that does not decode (a corrupt PNG, a name whose file was
  // deleted) shows the download row instead.
  const [broken, setBroken] = useState(false);
  const url = `${base}${attachment.name}`;

  if (attachment.inline && !broken) {
    // A button, not a link: the picture opens in the app (see Lightbox), the
    // way every other picture in a conversation does. A new tab would leave
    // the conversation behind and lose the scroll position on the way back.
    return (
      <button
        type="button"
        className="attach-image"
        onClick={onOpen}
        title={attachment.displayName}
        aria-label={attachment.displayName}
      >
        <img
          src={url}
          alt=""
          onError={() => setBroken(true)}
        />
      </button>
    );
  }

  return (
    <a
      className="attach-file"
      href={url}
      download={attachment.displayName}
      target="_blank"
      rel="noopener noreferrer"
      title={attachment.displayName}
    >
      <span className="attach-file-name">{attachment.displayName}</span>
      <span className="attach-file-size">
        {formatAttachmentSize(attachment.size)}
      </span>
      <span className="attach-file-action">{t("chat.attach.download")}</span>
    </a>
  );
}
