/**
 * Whether a reply's app cards are displayable.
 *
 * The model writes the card as text, so a valid fence is not a valid card.
 * The same parser the renderer uses runs here, before the reply is shown or
 * persisted: a failure becomes a message for the model, not a broken card on
 * the screen (see shared/ui-app/build.ts).
 */
import { splitChatText } from "../chat-ui/segments.ts";
import { parseAppSpec } from "./build.ts";

/** The first card in `text` that does not parse. */
export interface AppCardProblem {
  /** The parser's message, prefixed with the path it names. */
  problem: string;
  /** The JSON between the card's fences, as the model wrote it. */
  json: string;
}

/** The first unreadable app card in `text`, or null when every card parses. */
export function firstAppCardProblem(text: string): AppCardProblem | null {
  for (const segment of splitChatText(text)) {
    if (segment.type !== "app") continue;
    const parsed = parseAppSpec(segment.json);
    if (!parsed.ok) return { problem: parsed.problem, json: segment.json };
  }
  return null;
}
