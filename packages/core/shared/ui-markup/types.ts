/**
 * The shapes the UI markup parses into (see ./build.ts): the blocks a card
 * carries, the data a card may read, and the result of one parse.
 *
 * A parse keeps the binds as written (`<Repeat>`, `<If>`, `$item.x`); the
 * screen calls `resolveUiView` (./resolve.ts) once per draw to turn them into
 * the same blocks with literal text. A card is read from the message's own
 * text every time it is drawn, so a stored message always draws the same
 * picture.
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

/** One number worth its own line: a label, the value, and at most a unit and
 * a hint. A metric carries no formatting rule — the model writes the value
 * as the reader should see it ("81", "3.1%", "1.2 s"). */
export type UiMetricBlock = {
  type: "metric";
  label: string;
  value: string;
  unit: string | null;
  hint: string | null;
};

/** One option. */
export type UiOption = {
  label: string;
  description: string | null;
};

/** Choices whose label is sent as a message when pressed. */
export type UiChoiceBlock = {
  type: "choice";
  /** `"row"` draws them as a row of buttons instead of a list. */
  layout: "list" | "row";
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

/** A block that draws something and holds no other blocks. */
export type UiContentBlock =
  | UiTextBlock
  | UiListBlock
  | UiTableBlock
  | UiFlowBlock
  | UiMetricBlock
  | UiChoiceBlock
  | UiFormBlock;

/** Spacing between the blocks of a layout. */
export type UiGap = "s" | "m" | "l";

/** Blocks one above another. The type parameter is the blocks it holds: a
 * parsed card holds binds too, the screen's copy only draws. An interface,
 * not a type: it holds blocks, and blocks hold layouts. */
export interface UiStackBlock<TBlock> {
  type: "stack";
  gap: UiGap;
  blocks: readonly TBlock[];
}

/** Blocks side by side; they go one above another when the card is narrow. */
export interface UiColumnsBlock<TBlock> {
  type: "columns";
  gap: UiGap;
  blocks: readonly TBlock[];
}

/** Blocks in a grid of `columns` columns. */
export interface UiGridBlock<TBlock> {
  type: "grid";
  columns: number;
  blocks: readonly TBlock[];
}

/** A layout: the only blocks that hold other blocks (besides the binds). */
export type UiLayoutBlock =
  | UiStackBlock<UiBlock>
  | UiColumnsBlock<UiBlock>
  | UiGridBlock<UiBlock>;

/**
 * One condition on the item being repeated.
 *
 * Only "this field equals that text" is expressible: the model writes data,
 * not code, and a comparison is the one decision a card has to make. The
 * reference must address a field of the item (`$item.status`); comparing the
 * card's own data would be decided before the card was sent, so it is
 * refused.
 */
export type UiCondition = {
  /** The field of the item, without the `$item.` prefix. */
  field: string;
  /** The text the field must equal, or null when `ne` is used. */
  eq: string | null;
  /** The text the field must differ from, or null when `eq` is used. */
  ne: string | null;
};

/** Blocks drawn once per item of an array of the card's data. */
export type UiRepeatBlock = {
  type: "repeat";
  /** Path into the card's data (`envs`, `checks.results`). */
  over: string;
  blocks: readonly UiBlock[];
};

/** Blocks drawn only when the enclosing `<Repeat>`'s item matches. */
export type UiIfBlock = {
  type: "if";
  condition: UiCondition;
  blocks: readonly UiBlock[];
};

/** A block laid out in a card. */
export type UiBlock =
  | UiContentBlock
  | UiLayoutBlock
  | UiRepeatBlock
  | UiIfBlock;

/** A block after the binds are expanded: what the screen actually draws. */
export type UiResolvedBlock =
  | UiContentBlock
  | UiStackBlock<UiResolvedBlock>
  | UiColumnsBlock<UiResolvedBlock>
  | UiGridBlock<UiResolvedBlock>;

/** The card's data: the JSON carried by `<Data>`, which `$data` and the
 * `<Repeat>` paths read. Empty when the card carries none. */
export type UiData = Readonly<Record<string, unknown>>;

/** One card as written. */
export type UiView = {
  title: string | null;
  data: UiData;
  blocks: readonly UiBlock[];
};

/** One card as the screen draws it. */
export type UiResolvedView = {
  title: string | null;
  blocks: readonly UiResolvedBlock[];
};

/** The prose of one message, with the card blocks taken out. */
export type UiTextSegment = {
  type: "text";
  text: string;
};

/** One card a message wrote, as the markup between its fence's delimiters. */
export type UiCardSegment = {
  type: "card";
  markup: string;
};

/** One piece of a message, in the order the agent wrote it: a card is a
 * block OF the reply (see segments.ts), so prose may come before and after
 * it. */
export type UiSegment = UiTextSegment | UiCardSegment;

/** The result of a parse. On failure, `problem` says how to fix it (line,
 * column and reason). */
export type UiParseResult =
  | { ok: true; view: UiView }
  | { ok: false; problem: string };

/** The block that sends a message when pressed (Choice / Form), or null when
 * the card has none. The binds are searched too: a choice may sit inside a
 * layout or be drawn once per item. */
export function interactiveBlock(
  view: UiView | UiResolvedView,
): UiChoiceBlock | UiFormBlock | null {
  return interactiveIn(view.blocks);
}

function interactiveIn(
  blocks: readonly (UiBlock | UiResolvedBlock)[],
): UiChoiceBlock | UiFormBlock | null {
  for (const block of blocks) {
    if (block.type === "choice" || block.type === "form") return block;
    if (
      block.type === "stack" ||
      block.type === "columns" ||
      block.type === "grid" ||
      block.type === "repeat" ||
      block.type === "if"
    ) {
      const found = interactiveIn(block.blocks);
      if (found !== null) return found;
    }
  }
  return null;
}
