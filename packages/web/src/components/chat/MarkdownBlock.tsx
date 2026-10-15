import { memo, useMemo } from "preact/compat";
import { renderMarkdown } from "../../markdown.ts";
import { useT } from "../../i18n.ts";

/** Memoized markdown rendering: message text is static once a message is
 * complete, so a text delta must not re-parse every historical message.
 * `visualBase` (the session's asset base) is a plain string, so the memo
 * comparison stays cheap; a language switch re-renders in place — the block
 * subscribes to the language itself. */
export const MarkdownBlock = memo(function MarkdownBlock(
  { text, visualBase }: { text: string; visualBase: string },
) {
  const t = useT();
  const html = useMemo(
    () => renderMarkdown(text, { visualBase, t }),
    [text, visualBase, t],
  );
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
});
