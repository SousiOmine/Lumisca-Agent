import { useMemo } from "preact/compat";
import {
  parseUiMarkup,
  resolveUiView,
  type UiResolvedView,
} from "@lumisca/core/shared";
import { UiCard } from "./UiCard.tsx";

/**
 * A card, drawn from the markup a tool result carried.
 *
 * Parsing happens here (the server already refused anything this build cannot
 * read), and so does expanding the binds: the component below only ever sees
 * literal blocks, so a reader who reopens the conversation weeks later gets
 * the card the agent sent with the data it carried.
 */
export function CardView({
  markup,
  onSend,
}: {
  markup: string;
  /** Send the card's answer as the user's next message. */
  onSend: (text: string) => void;
}) {
  const view = useMemo<UiResolvedView | null>(() => {
    const parsed = parseUiMarkup(markup);
    return parsed.ok ? resolveUiView(parsed.view) : null;
  }, [markup]);
  return <UiCard view={view} onSend={onSend} />;
}
