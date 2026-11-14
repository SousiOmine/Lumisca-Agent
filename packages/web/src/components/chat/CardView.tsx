import {
  parseUiMarkup,
  parseUiMarkupPartial,
  resolveUiView,
  type UiResolvedView,
} from "@lumisca/core/shared";
import { useMemo } from "preact/compat";
import { InvalidCard, UiCard } from "./UiCard.tsx";

/**
 * A card, drawn from the markup a tool result carried.
 *
 * Parsing happens here, and so does expanding the binds: the component below
 * only ever sees literal blocks, so a reader who reopens the conversation
 * weeks later gets the card the agent sent with the data it carried.
 *
 * A card that does not read is drawn as the reader's note plus its source —
 * never as half a card, and never as nothing.
 */
export function CardView({
  markup,
  onSend,
  streaming = false,
}: {
  markup: string;
  /** Send the card's answer as the user's next message. */
  onSend: (text: string) => void;
  /** The markup is still being written: draw the blocks that have closed. A
   * card with nothing readable yet draws nothing — the "could not be
   * displayed" note is for a card that is FINISHED and wrong, and mid-stream
   * it would flash on every send. */
  streaming?: boolean;
}) {
  const view = useMemo<UiResolvedView | null>(() => {
    const parsed = streaming
      ? parseUiMarkupPartial(markup)
      : parseUiMarkup(markup);
    return parsed.ok ? resolveUiView(parsed.view) : null;
  }, [markup, streaming]);
  if (view === null) {
    return streaming ? null : <InvalidCard markup={markup} />;
  }
  return <UiCard view={view} onSend={onSend} />;
}
