/**
 * The markup for the cards drawn in the chat (see ./limits.ts).
 *
 * It is never executed as HTML (scripts, CSS, event attributes and URLs are
 * refused). The server's validation and the screen's rendering read it with
 * the same functions: `parseUiMarkup` reads it once, `resolveUiView` expands
 * the binds with the card's own data, and the screen draws the result.
 */

export { UI_MARKUP_LIMITS } from "./limits.ts";
export { interactiveBlock } from "./types.ts";
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
  UiStackBlock,
  UiTableBlock,
  UiTextBlock,
  UiView,
} from "./types.ts";
export { parseUiMarkup } from "./build.ts";
export { resolveUiView } from "./resolve.ts";
export { CARD_HELP } from "./help.ts";
