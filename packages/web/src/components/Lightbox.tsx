/**
 * The enlarged view of a picture: click a thumbnail, see the whole thing.
 *
 * A conversation draws pictures at a few hundred pixels because a message is
 * not a photo viewer — but a screenshot's text is unreadable at that size, and
 * the reason to show it is to be read. The click opens the original (never the
 * downscaled preview the list drew, see media/preview.ts), fills the window,
 * and closes on Escape, on the backdrop, or on the picture itself.
 *
 * Drawn as one element over the app rather than a route: looking at a picture
 * is not a place you navigate to, and leaving the conversation to see one
 * would lose the scroll position on the way back.
 */
import { useEffect } from "preact/compat";
import { useT } from "../i18n.ts";

export interface LightboxProps {
  /** The picture to show, already a URL the browser can load. */
  src: string;
  /** What the picture is called (the attachment's name), for the label. */
  alt?: string;
  onClose: () => void;
}

export function Lightbox({ src, alt, onClose }: LightboxProps) {
  const t = useT();
  // Escape closes it: a full-window overlay has to be dismissable from the
  // keyboard, and the picture is not a dialog the browser knows about.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    globalThis.addEventListener("keydown", onKey);
    // Scrolling the conversation behind an open picture would move what the
    // reader just left; the overlay takes the wheel instead.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      globalThis.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt ?? t("common.imagePreview")}
      onClick={onClose}
    >
      <img
        className="lightbox-image"
        src={src}
        alt={alt ?? ""}
        // The click that opened it must not also close it on the way through
        // this element.
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}
