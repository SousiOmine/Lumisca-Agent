/**
 * The markup for the cards drawn in the chat (see ./limits.ts).
 *
 * It is never executed as HTML (scripts, CSS, event attributes and URLs are
 * refused). The server's validation and the screen's rendering read it with
 * the same functions.
 */

export { UI_MARKUP_LIMITS } from "./limits.ts";
export { interactiveBlock } from "./types.ts";
export type {
  UiBlock,
  UiChoiceBlock,
  UiField,
  UiFieldType,
  UiFlowBlock,
  UiFlowEdge,
  UiFlowNode,
  UiFlowShape,
  UiFormBlock,
  UiListBlock,
  UiOption,
  UiParseResult,
  UiTableBlock,
  UiTextBlock,
  UiView,
} from "./types.ts";
export { parseUiMarkup } from "./build.ts";
