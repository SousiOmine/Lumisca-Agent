/**
 * The markup for the cards drawn in the chat (see ./limits.ts).
 *
 * It is never executed as HTML (scripts, CSS, event attributes and URLs are
 * refused). A card is written into a reply's text, so `splitChatText` cuts it
 * out of the prose (./segments.ts), `parseUiMarkup` reads it once,
 * `resolveUiView` expands the binds with the card's own data, and the screen
 * draws the result.
 */

export { parseUiMarkup, parseUiMarkupPartial } from "./build.ts";
export { CARD_HELP } from "./help.ts";
export { UI_MARKUP_LIMITS } from "./limits.ts";
export { resolveUiView } from "./resolve.ts";
export { segmentsText, splitChatText } from "./segments.ts";
export type {
  UiBlock,
  UiChoiceBlock,
  UiColumnsBlock,
  UiCondition,
  UiContentBlock,
  UiData,
  UiField,
  UiFieldType,
  UiFlowBlock,
  UiFlowEdge,
  UiFlowNode,
  UiFlowShape,
  UiFormBlock,
  UiGap,
  UiGridBlock,
  UiIfBlock,
  UiLayoutBlock,
  UiListBlock,
  UiMetricBlock,
  UiOption,
  UiParseResult,
  UiRepeatBlock,
  UiResolvedBlock,
  UiResolvedView,
  UiSegment,
  UiStackBlock,
  UiTableBlock,
  UiTextBlock,
  UiView,
} from "./types.ts";
export { interactiveBlock } from "./types.ts";
