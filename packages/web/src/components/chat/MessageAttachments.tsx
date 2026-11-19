import { formatAttachmentSize } from "@lumisca/core/shared";
import { IconDownload } from "@tabler/icons-preact";
import { useState } from "preact/hooks";
import { useT } from "../../i18n.ts";
import { Lightbox } from "../Lightbox.tsx";
import { attachmentIcon } from "./attachment-icon.ts";

/** One picture in a message's attachment block. */
export interface AttachmentImage {
  key: string;
  kind: "image";
  /** The name the control announces. Omitted for an image that arrived as a
   * content block, which has no file name. */
  name?: string;
  /** The thumbnail the grid draws. */
  src: string;
  /** The original the lightbox opens. Defaults to `src`. */
  fullSrc?: string;
}

/** One file in a message's attachment block. */
export interface AttachmentFile {
  key: string;
  kind: "file";
  name: string;
  size: number;
  /** Where the file is read from. */
  href: string;
  /** The name the browser saves under. Defaults to `name`. */
  downloadName?: string;
  /** Whether to ask the server before saving, so a file the machine no
   * longer has becomes a gone card. Off for a route that names the file
   * itself and answers with an attachment. */
  check?: boolean;
}

export type AttachmentView = AttachmentImage | AttachmentFile;

/**
 * The pictures and files one message brought in, as a block of its own.
 *
 * The words are the message and the attachments are what came with it, so
 * this block never draws the capsule's colour: a card is not part of a
 * sentence. The reader's own message keeps it at the right edge; an agent's
 * reply puts it at the left, 10px under the words.
 *
 * A picture is a tile that opens the original in the lightbox; a file is a
 * card with the kind's Tabler icon, its name, its size and a download. The
 * two shapes are one component because both modes hand the reader the same
 * objects, only with different sources: a prompt's files are read from the
 * machine by reference, an agent's from its session's attachment route.
 */
export function MessageAttachments({
  items,
  /** `agent` puts the block under a reply: left-aligned and 10px below the
   * words. The reader's own attachments keep the message's right edge. */
  className,
  /** The sentence a broken picture or a gone file shows. The default is the
   * session store's answer; a prompt file overrides it with the machine's. */
  missingText,
}: {
  items: readonly AttachmentView[];
  className?: string;
  missingText?: string;
}) {
  const t = useT();
  const missing = missingText ?? t("chat.attach.gone");
  const [open, setOpen] = useState<AttachmentImage | null>(null);
  const images = items.filter(
    (item): item is AttachmentImage => item.kind === "image",
  );
  const files = items.filter(
    (item): item is AttachmentFile => item.kind === "file",
  );

  if (items.length === 0) return null;
  return (
    <div className={`msg-attachments${className ? ` ${className}` : ""}`}>
      {images.length > 0 && (
        <ul
          className={`msg-attachment-images${
            images.length === 1 ? " single" : ""
          }`}
        >
          {images.map((item) => (
            <AttachmentImageTile
              key={item.key}
              item={item}
              missingText={missing}
              onOpen={() => setOpen(item)}
            />
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <ul className="msg-attachment-files">
          {files.map((item) => (
            <AttachmentFileCard
              key={item.key}
              item={item}
              missingText={missing}
            />
          ))}
        </ul>
      )}
      {/* Rendered even when closed: the overlay stays up while it shrinks
          (see Lightbox). */}
      <Lightbox
        src={open === null ? null : (open.fullSrc ?? open.src)}
        alt={open?.name}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}

/** One picture in the grid, or the sentence that says the machine no longer
 * has it. */
function AttachmentImageTile({
  item,
  missingText,
  onOpen,
}: {
  item: AttachmentImage;
  missingText: string;
  onOpen: () => void;
}) {
  const t = useT();
  const [gone, setGone] = useState(false);
  return (
    <li className="msg-attachment-image">
      {gone ? (
        <span className="msg-attachment-gone" title={item.name}>
          {missingText}
        </span>
      ) : (
        <button
          type="button"
          className="msg-attachment-image-button"
          title={item.name}
          aria-label={
            item.name === undefined
              ? t("common.imagePreview")
              : `${t("common.imagePreview")}: ${item.name}`
          }
          onClick={onOpen}
        >
          <img src={item.src} alt="" onError={() => setGone(true)} />
        </button>
      )}
    </li>
  );
}

/** One file as a card that downloads it. */
function AttachmentFileCard({
  item,
  missingText,
}: {
  item: AttachmentFile;
  missingText: string;
}) {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "checking" | "gone" | "failed">(
    "idle",
  );
  const Icon = attachmentIcon(item.name);
  const downloadName = item.downloadName ?? item.name;
  // A modified click is the browser's: a new tab or window is a deliberate
  // choice, and the download attribute would ignore it.
  const download = (event: {
    preventDefault: () => void;
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    if (status === "checking") return;
    setStatus("checking");
    void (async () => {
      try {
        // A machine that is starting can take a moment; a request that
        // never settles must not leave the card disabled for the rest of
        // the conversation.
        const response = await fetch(item.href, {
          signal: AbortSignal.timeout(30_000),
        });
        // The machine is the truth. A file the agent moved or deleted is
        // gone from the conversation too, and the card says so rather than
        // sending the reader to an error page.
        if (response.status === 404) {
          setStatus("gone");
          return;
        }
        if (!response.ok) {
          setStatus("failed");
          return;
        }
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = downloadName;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        // Give the browser the tick it needs to start the save before the
        // blob is released.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
        setStatus("idle");
      } catch {
        setStatus("failed");
      }
    })();
  };

  if (status === "gone") {
    return (
      <li>
        <div className="msg-attachment-file gone" role="status">
          <span className="msg-attachment-file-icon" aria-hidden="true">
            <Icon size={20} stroke={1.5} />
          </span>
          <span className="msg-attachment-file-body">
            <span className="msg-attachment-file-name">{item.name}</span>
            <span className="msg-attachment-file-size">{missingText}</span>
          </span>
        </div>
      </li>
    );
  }

  return (
    <li>
      <a
        className={`msg-attachment-file${
          status === "checking" ? " checking" : ""
        }`}
        href={item.href}
        download={downloadName}
        title={item.name}
        aria-busy={status === "checking" ? true : undefined}
        onClick={item.check === true ? (event) => download(event) : undefined}
      >
        <span className="msg-attachment-file-icon" aria-hidden="true">
          <Icon size={20} stroke={1.5} />
        </span>
        <span className="msg-attachment-file-body">
          <span className="msg-attachment-file-name">{item.name}</span>
          <span
            className={`msg-attachment-file-size${
              status === "failed" ? " error" : ""
            }`}
          >
            {status === "failed"
              ? t("chat.attach.downloadFailed")
              : formatAttachmentSize(item.size)}
          </span>
        </span>
        <IconDownload
          className="msg-attachment-file-action"
          size={15}
          stroke={1.5}
          aria-hidden="true"
        />
        <span className="visually-hidden">{t("chat.attach.download")}</span>
      </a>
    </li>
  );
}
