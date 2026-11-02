import { useState } from "preact/hooks";
import { useT } from "../../i18n.ts";
import { formatAttachmentSize, type PromptFileRef } from "@lumisca/core/shared";

/** Show one file a prompt brought in, read back from the machine.
 *
 * The bytes are not in the transcript any more: a conversation lives for
 * years, and every picture ever pasted into it would sit in the database
 * forever. They stay in the machine, where the agent works with them, and
 * this asks for one by the reference the message carries.
 *
 * That makes "gone" an ordinary state rather than an error: a file the agent
 * moved, edited or deleted is no longer in the machine, and a message app's
 * behaviour is the honest one — say the file is no longer available instead
 * of showing a copy that exists nowhere else. A picture is drawn once it
 * loads; anything else (and a picture that did not load) is a labelled row
 * naming the file, which is what a reader needs to know what was sent. */
export function PromptFiles({
  files,
  /** The conversation's upload endpoint, already carrying the agent. */
  base,
}: {
  files: readonly PromptFileRef[];
  base: string;
}) {
  const t = useT();
  const images = files.filter((file) => file.image);
  const others = files.filter((file) => !file.image);
  return (
    <>
      {images.length > 0 && (
        <div className="msg-images">
          {images.map((file) => (
            <PromptImage
              key={file.ref}
              file={file}
              src={`${base}?ref=${encodeURIComponent(file.ref)}`}
              goneLabel={t("chat.stella.fileGone")}
            />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <ul className="msg-files">
          {others.map((file) => (
            <li key={file.ref} className="msg-file">
              <span className="msg-file-name">{file.name}</span>
              <span className="msg-file-size">
                {formatAttachmentSize(file.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** One picture read back from the machine, or the sentence that says it is
 * no longer there. */
function PromptImage({
  file,
  src,
  goneLabel,
}: {
  file: PromptFileRef;
  src: string;
  goneLabel: string;
}) {
  const [gone, setGone] = useState(false);
  if (gone) {
    return (
      <span className="msg-file-gone" title={file.name}>
        {goneLabel}
      </span>
    );
  }
  return (
    <img
      className="msg-image"
      src={src}
      alt=""
      onError={() => setGone(true)}
    />
  );
}
