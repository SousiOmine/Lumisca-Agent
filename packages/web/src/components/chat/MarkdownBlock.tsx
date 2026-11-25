import { memo } from "preact/compat";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useT } from "../../i18n.ts";
import { renderMarkdown } from "../../markdown.ts";
import { Lightbox } from "../Lightbox.tsx";

const CODE_COPY_FEEDBACK_MS = 1500;

/** Memoized markdown rendering: message text is static once a message is
 * complete, so a text delta must not re-parse every historical message.
 * `visualBase` (the session's asset base) is a plain string, so the memo
 * comparison stays cheap; a language switch re-renders in place — the block
 * subscribes to the language itself. */
export const MarkdownBlock = memo(function MarkdownBlock({
  text,
  visualBase,
}: {
  text: string;
  visualBase: string;
}) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const [copiedAnnounce, setCopiedAnnounce] = useState(false);
  const copyTimers = useRef<
    Map<HTMLButtonElement, ReturnType<typeof setTimeout>>
  >(new Map());
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      for (const timer of copyTimers.current.values()) clearTimeout(timer);
      copyTimers.current.clear();
      if (announceTimer.current !== null) clearTimeout(announceTimer.current);
    },
    [],
  );
  const html = useMemo(
    () => renderMarkdown(text, { visualBase, t }),
    [text, visualBase, t],
  );
  // The rendered HTML cannot carry per-element handlers (the markup is a
  // string), so one listener answers for both controls inside it: code-block
  // copy buttons and the session's own visual assets (a remote image in prose
  // is not the session's to open at full size).
  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (target instanceof Element) {
      const copyButton = target.closest<HTMLButtonElement>(
        "button[data-code-copy]",
      );
      if (copyButton !== null) {
        const code =
          copyButton.closest(".md-code-block")?.querySelector("pre > code")
            ?.textContent ?? "";
        void navigator.clipboard
          ?.writeText(code)
          .then(() => {
            const prev = copyTimers.current.get(copyButton);
            if (prev !== undefined) clearTimeout(prev);
            copyButton.dataset.copied = "true";
            copyButton.textContent = t("chat.message.copied");
            setCopiedAnnounce(true);
            if (announceTimer.current !== null) {
              clearTimeout(announceTimer.current);
            }
            announceTimer.current = setTimeout(() => {
              setCopiedAnnounce(false);
              announceTimer.current = null;
            }, CODE_COPY_FEEDBACK_MS);
            const timer = setTimeout(() => {
              delete copyButton.dataset.copied;
              copyButton.textContent = t("chat.message.copy");
              copyTimers.current.delete(copyButton);
            }, CODE_COPY_FEEDBACK_MS);
            copyTimers.current.set(copyButton, timer);
          })
          .catch(() => {});
        return;
      }
    }
    if (!(target instanceof HTMLImageElement)) return;
    const src = target.getAttribute("src") ?? "";
    if (!src.startsWith(visualBase)) return;
    event.preventDefault();
    setOpen(src);
  };
  return (
    <>
      <div onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      <span className="visually-hidden" role="status">
        {copiedAnnounce ? t("chat.message.copied") : null}
      </span>
      {/* Rendered even when closed: the overlay stays up while it shrinks
          (see Lightbox). */}
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
  // The address may name another origin (the desktop shell's bundled UI
  // reads a remote server): keep it, and the token already in the query.
  return url.toString();
}
