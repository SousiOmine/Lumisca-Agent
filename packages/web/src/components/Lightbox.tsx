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
import { useRef } from "preact/compat";
import { useT } from "../i18n.ts";
import { useModalKeyboard } from "../hooks/useModalKeyboard.ts";

export interface LightboxProps {
  /** The picture to show, already a URL the browser can load. */
  src: string;
  /** What the picture is called (the attachment's name), for the label. */
  alt?: string;
  onClose: () => void;
}

export function Lightbox({ src, alt, onClose }: LightboxProps) {
  const t = useT();
  const overlayRef = useRef<HTMLDivElement>(null);
  // Escape, Tab, the focus and the scroll lock behind the overlay: the same
  // four things a dialog owes (see the hook).
  useModalKeyboard({ surface: overlayRef, onClose });

  return (
    <div
      ref={overlayRef}
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt ?? t("common.imagePreview")}
      tabIndex={-1}
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
