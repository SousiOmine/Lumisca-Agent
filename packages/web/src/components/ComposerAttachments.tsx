import { formatAttachmentSize } from "@lumisca/core/shared";
import { IconFile, IconX } from "@tabler/icons-preact";
import { useT } from "../i18n.ts";
import type { PendingFile, PendingImage } from "../types.ts";

/**
 * What the composer is about to send besides its text, above the field: the
 * pictures as tiles, the other files as chips carrying their transfer.
 *
 * Split out of Composer.tsx: none of this reads the field or the keyboard.
 * Every chip is the same three facts about one file (its name, how far its
 * transfer got, and the way to drop it), and the strip is the only part of
 * the composer that is drawn solely from the attachment lists.
 *
 * `error` sits here rather than beside the field because it is the answer to
 * the drop or the pick that made these chips: separated from them, a refusal
 * read as a message about the composer.
 */
export function ComposerAttachments({
  error,
  files,
  images,
  onImagesChange,
  onRemoveFile,
}: {
  /** Why the last pick or drop was refused, or null (see useAttachments). */
  error: string | null;
  files: readonly PendingFile[];
  images: readonly PendingImage[];
  /** Where the parent keeps the pictures; omitting it says this composer
   * holds none. */
  onImagesChange?: (images: PendingImage[]) => void;
  /** Drop one file, stopping its transfer when it is still running. */
  onRemoveFile: (file: PendingFile) => void;
}) {
  const t = useT();
  return (
    <>
      {error !== null && (
        <p className="input-attach-error" role="alert">
          {error}
        </p>
      )}
      {files.length > 0 && (
        <div className="input-files">
          {files.map((file) => {
            const percent =
              file.size === 0
                ? 100
                : Math.min(100, Math.round((file.uploaded / file.size) * 100));
            return (
              <span
                key={file.id}
                className={`input-file ${file.status}`}
                title={
                  file.error ??
                  `${file.name} (${formatAttachmentSize(file.size)})`
                }
              >
                <IconFile size={13} stroke={1.5} />
                <span className="input-file-name">{file.name}</span>
                <span className="input-file-size">
                  {file.status === "failed"
                    ? t("chat.composer.attach.failed")
                    : file.status === "copying"
                      ? t("chat.composer.attach.copying")
                      : file.status === "done"
                        ? formatAttachmentSize(file.size)
                        : `${percent}%`}
                </span>
                {file.status === "uploading" && (
                  <span className="input-file-progress" aria-hidden="true">
                    <span style={{ width: `${percent}%` }} />
                  </span>
                )}
                <button
                  type="button"
                  className="input-file-remove"
                  title={t("chat.composer.image.remove")}
                  onClick={() => onRemoveFile(file)}
                >
                  <IconX size={11} />
                </button>
              </span>
            );
          })}
        </div>
      )}
      {images.length > 0 && (
        <div className="input-images">
          {images.map((image, index) => (
            <div
              key={`${image.name ?? "image"}-${index}`}
              className="input-image"
            >
              <img
                src={image.data}
                alt={image.name ?? t("chat.composer.image.alt")}
              />
              <button
                type="button"
                className="input-image-remove"
                title={t("chat.composer.image.remove")}
                onClick={() =>
                  onImagesChange?.(images.filter((_, i) => i !== index))
                }
              >
                <IconX size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
