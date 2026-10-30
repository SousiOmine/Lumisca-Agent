import type { UiView } from "@lumisca/core/shared";
import { parseUiMarkup, TOOL_CHAT_UI } from "@lumisca/core/shared";
import type { ToolCallBlock } from "../../types.ts";

/**
 * The card a `chat_ui` tool call carries, if this call is one.
 *
 * The card lives in the call's own arguments, so it is drawn from the
 * transcript with no server state: a reload, a rewind or a session reopened
 * later draws the same card. Parsing here (rather than on the server) also
 * means the server never has to keep the parsed view around, and a markup
 * the server accepted but this build cannot read shows the "could not be
 * displayed" note rather than half a card.
 *
 * Returns `undefined` for any other tool call. A `chat_ui` call whose markup
 * does not parse returns `null`, which the card renders as that note.
 */
export function chatUiView(
  toolCall: ToolCallBlock,
): UiView | null | undefined {
  if (toolCall.name !== TOOL_CHAT_UI) return undefined;
  const args = toolCall.arguments as { markup?: unknown } | undefined;
  if (typeof args?.markup !== "string") return null;
  const parsed = parseUiMarkup(args.markup);
  return parsed.ok ? parsed.view : null;
}
