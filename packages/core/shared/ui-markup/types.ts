/**
 * The shapes the UI markup parses into (see ./build.ts): the blocks a card
 * carries, and the result of one parse.
 */

/** A paragraph. Line breaks are kept as written. */
export type UiTextBlock = {
  type: "text";
  text: string;
};

/** A bullet list; numbered when `ordered`. */
export type UiListBlock = {
  type: "list";
  ordered: boolean;
  items: readonly string[];
};

/** A table. The first row is treated as the header. */
export type UiTableBlock = {
  type: "table";
  rows: readonly (readonly string[])[];
};

/** Shape of a flowchart node. */
export type UiFlowShape = "box" | "round" | "diamond" | "pill";

/** One flowchart node. The id is how the edges name it. */
export type UiFlowNode = {
  id: string;
  label: string;
  shape: UiFlowShape;
};

/** One flowchart edge. */
export type UiFlowEdge = {
  from: string;
  to: string;
  label: string | null;
  dashed: boolean;
};

/** A flowchart. The screen places the nodes (the markup never does). */
export type UiFlowBlock = {
  type: "flow";
  nodes: readonly UiFlowNode[];
  edges: readonly UiFlowEdge[];
};

/** One option. */
export type UiOption = {
  label: string;
  description: string | null;
};

/** Choices whose label is sent as a message when pressed. */
export type UiChoiceBlock = {
  type: "choice";
  multiple: boolean;
  options: readonly UiOption[];
};

/** Kind of a form field. */
export type UiFieldType = "text" | "number" | "select" | "checkbox";

/** One form field. */
export type UiField = {
  label: string;
  type: UiFieldType;
  required: boolean;
  placeholder: string | null;
  /** Options are carried only when `type` is select. */
  options: readonly UiOption[];
};

/** A form that is filled in and submitted. */
export type UiFormBlock = {
  type: "form";
  submit: string | null;
  fields: readonly UiField[];
};

/** A block laid out in a card. */
export type UiBlock =
  | UiTextBlock
  | UiListBlock
  | UiTableBlock
  | UiFlowBlock
  | UiChoiceBlock
  | UiFormBlock;

/** One card. */
export type UiView = {
  title: string | null;
  blocks: readonly UiBlock[];
};

/** The result of a parse. On failure, `problem` says how to fix it (line,
 * column and reason). */
export type UiParseResult =
  | { ok: true; view: UiView }
  | { ok: false; problem: string };

/** The block that sends a message when pressed (Choice / Form), or null when
 * the card has none. */
export function interactiveBlock(
  view: UiView,
): UiChoiceBlock | UiFormBlock | null {
  for (const block of view.blocks) {
    if (block.type === "choice" || block.type === "form") return block;
  }
  return null;
}
