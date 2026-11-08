import { memo, useMemo, useState } from "preact/compat";
import { renderMarkdown } from "../../markdown.ts";
import { useT } from "../../i18n.ts";
import { Lightbox } from "../Lightbox.tsx";

/** Memoized markdown rendering: message text is static once a message is
 * complete, so a text delta must not re-parse every historical message.
 * `visualBase` (the session's asset base) is a plain string, so the memo
 * comparison stays cheap; a language switch re-renders in place — the block
 * subscribes to the language itself. */
export const MarkdownBlock = memo(function MarkdownBlock(
  { text, visualBase }: { text: string; visualBase: string },
) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const html = useMemo(
    () => renderMarkdown(text, { visualBase, t }),
    [text, visualBase, t],
  );
  // The pictures in the rendered HTML cannot each carry a handler (the markup
  // is a string), so one listener answers for all of them: a picture inside
  // the block opens enlarged. Only the session's own visual assets take part —
  // a remote image in prose is not the session's to open, and its URL is not
  // something this block should load at full size.
  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) return;
    const src = target.getAttribute("src") ?? "";
    if (!src.startsWith(visualBase)) return;
    event.preventDefault();
    setOpen(src);
  };
  return (
    <>
      <div onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      {
        /* Rendered even when closed: the overlay stays up while it shrinks
          (see Lightbox). */
      }
      <Lightbox
        src={open === null ? null : openFullSize(open)}
        onClose={() => setOpen(null)}
      />
    </>
  );
});

/** The original behind a preview URL. The thumbnail asked for the downscaled
 * copy (the route's default); the lightbox wants the bytes themselves. */
function openFullSize(src: string): string {
  const url = new URL(src, globalThis.location.href);
  url.searchParams.set("preview", "0");
  return url.pathname + url.search;
}
