import { memo } from "react";
import { renderMarkdown } from "../../markdown.ts";

/** Memoized markdown rendering: message text is static once a message is
 * complete, so a text delta must not re-parse every historical message. */
export const MarkdownBlock = memo(function MarkdownBlock(
  { text }: { text: string },
) {
  return <div dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
});
