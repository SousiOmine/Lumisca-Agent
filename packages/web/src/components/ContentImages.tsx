import { toDataUrl } from "@lumisca/core/shared";
import { useState } from "preact/hooks";
import { useT } from "../i18n.ts";
import { Lightbox } from "./Lightbox.tsx";

/** Render image content blocks (base64 `data`) as thumbnails that open
 * enlarged when clicked. Used by tool results: a user message's pictures are
 * drawn by the shared attachment block instead, because they are part of
 * what the reader sent.
 *
 * The thumbnail is the block's own bytes: these are the images a message
 * carries, not a published asset with a route of its own, so there is nothing
 * to downscale on the server (they were already capped when the message was
 * made). A bigger conversation's pictures are the ones served from a store,
 * and those arrive as URLs (see PromptAttachments, VisualImages). */
export function ContentImages({
  images,
}: {
  images: Array<{ type: "image"; data: string; mimeType: string }>;
}) {
  const t = useT();
  const [open, setOpen] = useState<number | null>(null);
  const sources = images.map((image) => toDataUrl(image.mimeType, image.data));
  return (
    <>
      <div className="msg-images">
        {sources.map((src, index) => (
          // A picture in a message is there to be looked at, so the button
          // opens it whole (see Lightbox). The button is the control, not the
          // image: it is reachable by keyboard and carries the name.
          <button
            key={index}
            type="button"
            className="msg-image-button"
            aria-label={t("common.imagePreview")}
            onClick={() => setOpen(index)}
          >
            <img className="msg-image" src={src} alt="" />
          </button>
        ))}
      </div>
      {/* Rendered even when closed: the overlay stays up while it shrinks
          (see Lightbox). */}
      <Lightbox
        src={open === null ? null : (sources[open] ?? null)}
        onClose={() => setOpen(null)}
      />
    </>
  );
}
