import { toDataUrl } from "@lumisca/core/shared";
import { useState } from "preact/compat";
import { Lightbox } from "./Lightbox.tsx";

/** Render image content blocks (base64 `data`) as thumbnails that open
 * enlarged when clicked. Shared by user messages and tool results in both
 * modes.
 *
 * The thumbnail is the block's own bytes: these are the images a message
 * carries, not a published asset with a route of its own, so there is nothing
 * to downscale on the server (they were already capped when the message was
 * made). A bigger conversation's pictures are the ones served from a store,
 * and those arrive as URLs (see PromptFiles, VisualImages). */
export function ContentImages({
  images,
}: {
  images: Array<{ type: "image"; data: string; mimeType: string }>;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const sources = images.map((image) => toDataUrl(image.mimeType, image.data));
  return (
    <>
      <div className="msg-images">
        {sources.map((src, index) => (
          <img
            key={index}
            className="msg-image"
            src={src}
            alt=""
            // A picture in a message is there to be looked at, so clicking it
            // opens it whole (see Lightbox).
            onClick={() => setOpen(index)}
          />
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
