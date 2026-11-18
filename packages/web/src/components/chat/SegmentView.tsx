import type { UiSegment } from "@lumisca/core/shared";
import { AppCard } from "./AppCard.tsx";
import { MarkdownBlock } from "./MarkdownBlock.tsx";

/**
 * One piece of a reply: its prose, or an app card drawn where the agent
 * wrote it.
 *
 * The card is the only segment that needs parsing, and it does that itself
 * (see AppCard). Keeping the choice in one component is what makes every
 * transcript, stella's and code mode's, draw the same message the same way.
 */
export function SegmentView({
  segment,
  onSend,
  streaming = false,
  visualBase,
}: {
  segment: UiSegment;
  /** Send the card's answer as the user's next message. Omitted in a
   * read-only conversation. */
  onSend?: (text: string) => void;
  /** The text is still arriving: a card draws what has closed. */
  streaming?: boolean;
  /** Asset base of the session, for `visual:` images in the prose. */
  visualBase: string;
}) {
  if (segment.type === "app") {
    return (
      <AppCard json={segment.json} onSend={onSend} streaming={streaming} />
    );
  }
  return <MarkdownBlock text={segment.text} visualBase={visualBase} />;
}
