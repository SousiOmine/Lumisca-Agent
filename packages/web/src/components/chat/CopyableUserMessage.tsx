import { toDataUrl } from "@lumisca/core/shared";
import { IconArrowBackUp } from "@tabler/icons-preact";
import { useT } from "../../i18n.ts";
import {
  type AttachmentView,
  MessageAttachments,
} from "./MessageAttachments.tsx";
import { MessageCopyButton } from "./MessageCopyButton.tsx";
import type { UserMessageImage } from "./types.ts";

/** A user message with its action row: rewind (restore to the composer)
 * and copy. When `modeLabel` is set, the message is a mode-generated
 * message (e.g. review) and the badge is shown. `rewindText` overrides
 * what the rewind action restores to the composer (mode messages keep
 * their short text in the bubble, but may come back as a command line —
 * see modeRewindText in slashCommands.ts). */
export function CopyableUserMessage({
  text,
  images,
  timestamp,
  modeLabel,
  rewindText,
  onRewind,
}: {
  text: string;
  images: UserMessageImage[];
  timestamp: number;
  modeLabel?: string;
  /** Text restored to the composer by the rewind action; defaults to
   * `text` (the bubble content). */
  rewindText?: string;
  onRewind: (
    timestamp: number,
    text: string,
    images: UserMessageImage[],
  ) => void;
}) {
  const t = useT();
  // A code-mode prompt's pictures are content blocks carried by the message:
  // their data URL is both the thumbnail and the original. They are mapped
  // onto the same block a stella prompt's files use, so both modes draw a
  // user's attachments the same way.
  const attachmentItems: AttachmentView[] = images.map((image, index) => ({
    key: String(index),
    kind: "image",
    src: toDataUrl(image.mimeType, image.data),
  }));

  return (
    <div className="msg-user-wrap">
      {text && (
        <div className="msg user">
          <div className="msg-body">
            <p className="msg-user-text">{text}</p>
          </div>
        </div>
      )}
      {images.length > 0 && <MessageAttachments items={attachmentItems} />}
      <div className="msg-user-actions">
        <button
          type="button"
          className="msg-action-btn"
          aria-label={t("chat.message.rewind")}
          onClick={() => onRewind(timestamp, rewindText ?? text, images)}
        >
          <IconArrowBackUp size={16} stroke={1.5} />
        </button>
        {text && <MessageCopyButton text={text} />}
        {modeLabel && <div className="msg-mode-badge">{modeLabel}</div>}
      </div>
    </div>
  );
}
