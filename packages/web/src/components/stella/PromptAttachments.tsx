import { formatAttachmentSize, type PromptFileRef } from "@lumisca/core/shared";
import { IconDownload } from "@tabler/icons-preact";
import { useState } from "preact/hooks";
import { useT } from "../../i18n.ts";
import { attachmentIcon } from "../chat/attachment-icon.ts";
import { Lightbox } from "../Lightbox.tsx";

/**
 * The pictures and files a prompt brought in, under the message's text and
 * outside its capsule.
 *
 * They used to sit inside the bubble, which made the bubble their container:
 * a one-line caption beside a file became a wide coloured box with a list in
 * it, and the list itself was only names and sizes. A message app draws the
 * two as separate objects — the words are the message, the attachments are
 * what came with it — so the block here is a sibling of the bubble and keeps
 * the message's right alignment.
 *
 * The bytes live in the machine, not in the transcript (see PromptFileRef).
 * A picture is fetched through the conversation's upload route and drawn as
 * a tile; anything else is a card that downloads the file by the same route.
 * A file the machine no longer has is an ordinary state: the picture's load
 * turns the tile into the sentence that says so, and the card checks before
 * it downloads.
 */
export function PromptAttachments({
  files,
  /** The conversation's upload endpoint, already carrying the agent. */
  base,
}: {
  files: readonly PromptFileRef[];
  base: string;
}) {
  const [open, setOpen] = useState<PromptFileRef | null>(null);
  const images = files.filter((file) => file.image);
  const others = files.filter((file) => !file.image);

  /** One file's URL. `preview` is the downscaled copy the grid draws; the
   * original is what a click opens and what a card downloads. */
  const srcOf = (file: PromptFileRef, preview: boolean) =>
    `${base}?ref=${encodeURIComponent(file.ref)}${preview ? "" : "&preview=0"}`;

  if (files.length === 0) return null;
  return (
    <div className="msg-attachments">
      {images.length > 0 && (
        <ul
          className={`msg-attachment-images${
            images.length === 1 ? " single" : ""
          }`}
        >
          {images.map((file) => (
            <PromptImage
              key={file.ref}
              file={file}
              src={srcOf(file, true)}
              onOpen={() => setOpen(file)}
            />
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="msg-attachment-files">
          {others.map((file) => (
            <PromptFileCard key={file.ref} file={file} base={base} />
          ))}
        </ul>
      )}
      {/* Rendered even when closed: the overlay stays up while it shrinks
          (see Lightbox). */}
      <Lightbox
        src={open === null ? null : srcOf(open, false)}
        alt={open?.name}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}

/** One picture in the grid, or the sentence that says the machine no longer
 * has it. */
function PromptImage({
  file,
  src,
  onOpen,
}: {
  file: PromptFileRef;
  src: string;
  onOpen: () => void;
}) {
  const t = useT();
  const [gone, setGone] = useState(false);
  return (
    <li className="msg-attachment-image">
      {gone ? (
        <span className="msg-attachment-gone" title={file.name}>
          {t("chat.stella.fileGone")}
        </span>
      ) : (
        <button
          type="button"
          className="msg-attachment-image-button"
          title={file.name}
          aria-label={`${t("common.imagePreview")}: ${file.name}`}
          onClick={onOpen}
        >
          <img src={src} alt="" onError={() => setGone(true)} />
        </button>
      )}
    </li>
  );
}

/** One file the prompt brought in, as a card that downloads it. */
function PromptFileCard({ file, base }: { file: PromptFileRef; base: string }) {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "checking" | "gone" | "failed">(
    "idle",
  );
  // `preview=0` asks for the file itself: a document is not a picture and
  // must not go through the image downscaler.
  const url = `${base}?ref=${encodeURIComponent(file.ref)}&preview=0`;
  const Icon = attachmentIcon(file.name);

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
        const response = await fetch(url, {
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
        anchor.download = file.name;
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
            <span className="msg-attachment-file-name">{file.name}</span>
            <span className="msg-attachment-file-size">
              {t("chat.stella.fileGone")}
            </span>
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
        href={url}
        download={file.name}
        title={file.name}
        aria-busy={status === "checking" ? true : undefined}
        onClick={(event) => download(event)}
      >
        <span className="msg-attachment-file-icon" aria-hidden="true">
          <Icon size={20} stroke={1.5} />
        </span>
        <span className="msg-attachment-file-body">
          <span className="msg-attachment-file-name">{file.name}</span>
          <span
            className={`msg-attachment-file-size${
              status === "failed" ? " error" : ""
            }`}
          >
            {status === "failed"
              ? t("chat.attach.downloadFailed")
              : formatAttachmentSize(file.size)}
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
