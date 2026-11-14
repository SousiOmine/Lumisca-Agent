import { UI_MARKUP_LIMITS } from "./limits.ts";
import {
  ALL_TAGS,
  BLOCK_TAGS,
  cardPrefix,
  fail,
  MarkupError,
  parseDocument,
  positionOf,
  type RawElement,
} from "./reader.ts";
import type {
  UiBlock,
  UiChoiceBlock,
  UiCondition,
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
  UiLayoutBlock,
  UiListBlock,
  UiMetricBlock,
  UiOption,
  UiParseResult,
  UiTableBlock,
  UiView,
} from "./types.ts";

/** Rearrange the tree of tags into the grammar's card. */

/** What a content string may read while it is being checked.
 *
 * `items` is the array of the enclosing `<Repeat>` (null outside one): a
 * `$item.x` reference is only a value once an item is known, so it is read
 * against every item the card repeats over. A field missing from one item is
 * refused here rather than drawn as an empty line. */
type Scope = {
  readonly data: UiData;
  readonly items: readonly unknown[] | null;
};

function buildView(root: RawElement): UiView {
  if (root.name !== "Card") {
    fail(root.at, `the root must be <Card>, not <${root.name}>`);
  }
  checkAttributes(root, ["title"]);

  const children = elementChildren(root, ["Data", ...BLOCK_TAGS]);
  const dataNodes = children.filter((child) => child.name === "Data");
  if (dataNodes.length > 1) {
    fail(dataNodes[1]!.at, "a card carries at most one <Data>");
  }
  const dataNode = dataNodes[0];
  if (dataNode !== undefined) {
    const firstBlock = children.find((child) => child.name !== "Data");
    if (firstBlock !== undefined && firstBlock.at < dataNode.at) {
      fail(dataNode.at, "write <Data> before the blocks that read it");
    }
  }

  const data = dataNode === undefined ? {} : buildData(dataNode);
  const scope: Scope = { data, items: null };
  const title = contentAttribute(
    root,
    "title",
    UI_MARKUP_LIMITS.titleChars,
    scope,
  );

  const nodes = children.filter((child) => child.name !== "Data");
  if (nodes.length === 0) fail(root.at, "<Card> needs at least one block");

  const blocks = nodes.map((node) => buildBlock(node, scope));
  const written = countBlocks(blocks);
  if (written > UI_MARKUP_LIMITS.blocks) {
    fail(
      root.at,
      `<Card> has ${written} blocks; the limit is ${UI_MARKUP_LIMITS.blocks}`,
    );
  }
  const expanded = expandedBlocks(blocks, data);
  if (expanded > UI_MARKUP_LIMITS.expandedBlocks) {
    fail(
      root.at,
      `the repeats expand to ${expanded} blocks; the limit is ` +
        `${UI_MARKUP_LIMITS.expandedBlocks} (send fewer items)`,
    );
  }

  const interactive = interactiveCount(blocks);
  if (interactive > 1) {
    fail(root.at, "a card can have at most one <Choice> or <Form>");
  }

  return { title, data, blocks };
}

/** The JSON of `<Data>`. Everything the model put there is read here once, so
 * paths, repeats and conditions are checked against real values rather than
 * against a promise. */
function buildData(node: RawElement): UiData {
  checkAttributes(node, []);

  const raw = node.children
    .map((child) => (child.kind === "text" ? child.text : ""))
    .join("")
    .trim();
  if (raw.length === 0) {
    fail(
      node.at,
      '<Data> is empty; it needs one JSON object, e.g. {"items":[]}',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(node.at, `<Data> is not valid JSON: ${reason}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(node.at, '<Data> must be a JSON object, e.g. {"items":[…]}');
  }

  checkKeys(parsed as Record<string, unknown>, node.at, "");
  return parsed as UiData;
}

/** Keys are written by the model and read back by path; a key that Object
 * would answer for ("__proto__") is refused so a path can never leave the
 * data the card carried. */
function checkKeys(
  value: Record<string, unknown>,
  at: number,
  prefix: string,
): void {
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      fail(at, `the data key "${key}" is reserved`);
    }
    if (key.length > UI_MARKUP_LIMITS.dataKeyChars) {
      fail(
        at,
        `the data key "${key}" is ${key.length} characters; the limit is ` +
          `${UI_MARKUP_LIMITS.dataKeyChars}`,
      );
    }
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      fail(
        at,
        `the data key "${key}" must use letters, digits, "_" or "-" ` +
          "(a path is written with dots)",
      );
    }
    if (Array.isArray(child)) {
      for (const item of child) {
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          checkKeys(item as Record<string, unknown>, at, `${prefix}${key}.`);
        }
      }
    } else if (typeof child === "object" && child !== null) {
      checkKeys(child as Record<string, unknown>, at, `${prefix}${key}.`);
    }
  }
}

function buildBlock(node: RawElement, scope: Scope): UiBlock {
  switch (node.name) {
    case "Text":
      checkAttributes(node, []);
      return {
        type: "text",
        text: contentText(node, UI_MARKUP_LIMITS.textChars, "the text", scope),
      };

    case "List":
      return buildList(node, scope);

    case "Table":
      return buildTable(node, scope);

    case "Flow":
      return buildFlow(node, scope);

    case "Metric":
      return buildMetric(node, scope);

    case "Choice":
      return buildChoice(node, scope);

    case "Form":
      return buildForm(node, scope);

    case "Stack":
    case "Columns":
    case "Grid":
      return buildLayout(node, scope);

    case "Repeat":
      return buildRepeat(node, scope);

    case "If":
      return buildIf(node, scope);

    default:
      fail(
        node.at,
        `unknown tag <${node.name}> (allowed: ${ALL_TAGS.join(", ")})`,
      );
  }
}

function buildMetric(node: RawElement, scope: Scope): UiMetricBlock {
  checkAttributes(node, ["label", "value", "unit", "hint"]);
  noContent(node);

  return {
    type: "metric",
    label: requiredContentAttribute(
      node,
      "label",
      UI_MARKUP_LIMITS.metricLabelChars,
      scope,
    ),
    value: requiredContentAttribute(
      node,
      "value",
      UI_MARKUP_LIMITS.metricValueChars,
      scope,
    ),
    unit: contentAttribute(
      node,
      "unit",
      UI_MARKUP_LIMITS.metricUnitChars,
      scope,
    ),
    hint: contentAttribute(
      node,
      "hint",
      UI_MARKUP_LIMITS.metricHintChars,
      scope,
    ),
  };
}

function buildLayout(node: RawElement, scope: Scope): UiLayoutBlock {
  if (node.name === "Grid") {
    checkAttributes(node, ["columns"]);
    const columns = numberAttribute(node, "columns") ?? 2;
    if (columns < 1 || columns > UI_MARKUP_LIMITS.gridColumns) {
      fail(
        node.at,
        `columns is ${columns}; it must be 1 to ${UI_MARKUP_LIMITS.gridColumns}`,
      );
    }
    const blocks = layoutChildren(node, scope);
    const grid: UiGridBlock<UiBlock> = { type: "grid", columns, blocks };
    return grid;
  }

  checkAttributes(node, ["gap"]);
  const gap = gapAttribute(node);
  const blocks = layoutChildren(node, scope);
  return node.name === "Stack"
    ? { type: "stack", gap, blocks }
    : { type: "columns", gap, blocks };
}

function layoutChildren(node: RawElement, scope: Scope): UiBlock[] {
  const blocks = elementChildren(node, BLOCK_TAGS).map((child) =>
    buildBlock(child, scope),
  );
  if (blocks.length === 0) {
    fail(node.at, `<${node.name}> needs at least one block`);
  }
  if (blocks.length > UI_MARKUP_LIMITS.blocks) {
    fail(
      node.at,
      `<${node.name}> has ${blocks.length} blocks; the limit is ` +
        `${UI_MARKUP_LIMITS.blocks}`,
    );
  }
  return blocks;
}

function buildRepeat(node: RawElement, scope: Scope): UiBlock {
  checkAttributes(node, ["over"]);
  if (scope.items !== null) {
    fail(node.at, "a <Repeat> cannot sit inside another <Repeat>");
  }

  const over = requiredAttribute(node, "over", UI_MARKUP_LIMITS.dataPathChars);
  checkPath(over, node.at);

  const value = valueAt(scope.data, over);
  if (!value.found) {
    fail(node.at, `<Repeat over="${over}"> names no field of <Data>`);
  }
  if (!Array.isArray(value.value)) {
    fail(node.at, `<Repeat over="${over}"> must name an array in <Data>`);
  }
  const items = value.value as readonly unknown[];
  if (items.length > UI_MARKUP_LIMITS.repeatItems) {
    fail(
      node.at,
      `"${over}" has ${items.length} items; the limit is ` +
        `${UI_MARKUP_LIMITS.repeatItems}`,
    );
  }

  const inner: Scope = { data: scope.data, items };
  const blocks = elementChildren(node, BLOCK_TAGS).map((child) =>
    buildBlock(child, inner),
  );
  if (blocks.length === 0) fail(node.at, "<Repeat> needs at least one block");
  return { type: "repeat", over, blocks };
}

function buildIf(node: RawElement, scope: Scope): UiBlock {
  checkAttributes(node, ["test", "eq", "ne"]);
  const test = requiredAttribute(node, "test", UI_MARKUP_LIMITS.dataPathChars);
  const eq = stringAttribute(node, "eq", UI_MARKUP_LIMITS.optionLabelChars);
  const ne = stringAttribute(node, "ne", UI_MARKUP_LIMITS.optionLabelChars);
  if ((eq === null) === (ne === null)) {
    fail(node.at, '<If> needs exactly one of "eq" and "ne"');
  }

  const field = itemReference(test, node.at, scope);
  assertFieldOnItems(field, node.at, scope);

  const blocks = elementChildren(node, BLOCK_TAGS).map((child) =>
    buildBlock(child, scope),
  );
  if (blocks.length === 0) fail(node.at, "<If> needs at least one block");

  const condition: UiCondition = { field, eq, ne };
  return { type: "if", condition, blocks };
}

/** `<If test>` names a field of the repeated item, and nothing else: a
 * condition on the card's own data would have been decided before the card
 * was written. */
function itemReference(test: string, at: number, scope: Scope): string {
  if (scope.items === null) {
    fail(at, "<If> can only sit inside a <Repeat>");
  }
  const match = /^\$item(?:\.([A-Za-z0-9_.-]+))?$/.exec(test);
  if (match === null) {
    fail(
      at,
      `<If test="${test}"> must name a field of the item, e.g. ` +
        "$item.status",
    );
  }
  const field = match[1];
  if (field === undefined) {
    fail(at, "<If test> must name a field, e.g. $item.status");
  }
  checkPath(field, at);
  return field;
}

function assertFieldOnItems(field: string, at: number, scope: Scope): void {
  const items = scope.items ?? [];
  for (const item of items) {
    const value = valueAt(item, field);
    if (!value.found) {
      fail(at, `the repeated items have no field "${field}"`);
    }
    if (!isScalar(value.value)) {
      fail(at, `"${field}" must be text, a number or true/false`);
    }
  }
}

function buildList(node: RawElement, scope: Scope): UiListBlock {
  checkAttributes(node, ["ordered"]);
  const ordered = flagAttribute(node, "ordered");
  const items = elementChildren(node, ["Item"]).map((item) => {
    checkAttributes(item, []);
    return contentText(
      item,
      UI_MARKUP_LIMITS.listItemChars,
      "a list item",
      scope,
    );
  });

  if (items.length === 0) fail(node.at, "<List> needs at least one <Item>");
  if (items.length > UI_MARKUP_LIMITS.listItems) {
    fail(
      node.at,
      `<List> has ${items.length} items; the limit is ${UI_MARKUP_LIMITS.listItems}`,
    );
  }

  return { type: "list", ordered, items };
}

function buildTable(node: RawElement, scope: Scope): UiTableBlock {
  checkAttributes(node, []);

  const rows = elementChildren(node, ["Row"]).map((row) => {
    checkAttributes(row, []);
    const cells = elementChildren(row, ["Cell"]).map((cell) => {
      checkAttributes(cell, []);
      return contentText(
        cell,
        UI_MARKUP_LIMITS.tableCellChars,
        "a table cell",
        scope,
      );
    });
    return { at: row.at, cells };
  });

  if (rows.length === 0) fail(node.at, "<Table> needs at least one <Row>");
  if (rows.length > UI_MARKUP_LIMITS.tableRows) {
    fail(
      node.at,
      `<Table> has ${rows.length} rows; the limit is ${UI_MARKUP_LIMITS.tableRows}`,
    );
  }

  const first = rows[0];
  if (first === undefined) fail(node.at, "<Table> needs at least one <Row>");
  const columns = first.cells.length;
  if (columns === 0) fail(first.at, "<Row> needs at least one <Cell>");
  if (columns > UI_MARKUP_LIMITS.tableColumns) {
    fail(
      first.at,
      `a row has ${columns} cells; the limit is ${UI_MARKUP_LIMITS.tableColumns}`,
    );
  }

  for (const row of rows) {
    if (row.cells.length !== columns) {
      fail(
        row.at,
        `every row needs ${columns} cells, but this row has ${row.cells.length}`,
      );
    }
  }

  return { type: "table", rows: rows.map((row) => row.cells) };
}

function buildFlow(node: RawElement, scope: Scope): UiFlowBlock {
  checkAttributes(node, []);

  const nodes: UiFlowNode[] = [];
  const edges: { at: number; edge: UiFlowEdge }[] = [];

  for (const element of elementChildren(node, ["Node", "Edge"])) {
    if (element.name === "Node") {
      nodes.push(readFlowNode(element, nodes, scope));
      continue;
    }
    edges.push(readFlowEdge(element, scope));
  }

  if (nodes.length === 0) fail(node.at, "<Flow> needs at least one <Node>");
  if (nodes.length > UI_MARKUP_LIMITS.flowNodes) {
    fail(
      node.at,
      `<Flow> has ${nodes.length} nodes; the limit is ${UI_MARKUP_LIMITS.flowNodes}`,
    );
  }
  if (edges.length > UI_MARKUP_LIMITS.flowEdges) {
    fail(
      node.at,
      `<Flow> has ${edges.length} edges; the limit is ${UI_MARKUP_LIMITS.flowEdges}`,
    );
  }

  const ids = new Set(nodes.map((entry) => entry.id));
  for (const { at, edge } of edges) {
    if (!ids.has(edge.from)) {
      fail(at, `the edge refers to the unknown node "${edge.from}"`);
    }
    if (!ids.has(edge.to)) {
      fail(at, `the edge refers to the unknown node "${edge.to}"`);
    }
  }

  return { type: "flow", nodes, edges: edges.map((entry) => entry.edge) };
}

function readFlowNode(
  node: RawElement,
  nodes: readonly UiFlowNode[],
  scope: Scope,
): UiFlowNode {
  checkAttributes(node, ["id", "shape"]);

  const id = requiredAttribute(node, "id", UI_MARKUP_LIMITS.nodeIdChars);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    fail(node.at, `the node id "${id}" must use letters, digits, "_" or "-"`);
  }
  if (nodes.some((other) => other.id === id)) {
    fail(node.at, `the node id "${id}" is used twice`);
  }

  const shape = flowShape(node);
  const label = contentText(
    node,
    UI_MARKUP_LIMITS.flowLabelChars,
    `the label of node "${id}"`,
    scope,
  );
  return { id, label, shape };
}

function flowShape(node: RawElement): UiFlowShape {
  const value = stringAttribute(node, "shape", 20);
  if (value === null) return "box";
  if (
    value === "box" ||
    value === "round" ||
    value === "diamond" ||
    value === "pill"
  ) {
    return value;
  }
  fail(node.at, `unknown shape "${value}" (use box, round, diamond or pill)`);
}

function readFlowEdge(
  node: RawElement,
  scope: Scope,
): { at: number; edge: UiFlowEdge } {
  checkAttributes(node, ["from", "to", "label", "dashed"]);
  noContent(node);

  const from = requiredAttribute(node, "from", UI_MARKUP_LIMITS.nodeIdChars);
  const to = requiredAttribute(node, "to", UI_MARKUP_LIMITS.nodeIdChars);
  if (from === to) fail(node.at, "an <Edge> must connect two different nodes");

  const label = contentAttribute(
    node,
    "label",
    UI_MARKUP_LIMITS.flowEdgeLabelChars,
    scope,
  );
  return {
    at: node.at,
    edge: { from, to, label, dashed: flagAttribute(node, "dashed") },
  };
}

function buildChoice(node: RawElement, scope: Scope): UiChoiceBlock {
  checkAttributes(node, ["multiple", "layout"]);
  const multiple = flagAttribute(node, "multiple");
  const layout = choiceLayout(node);
  const options = readOptions(node, scope);

  if (options.length < 2) fail(node.at, "<Choice> needs at least two <Option>");
  if (options.length > UI_MARKUP_LIMITS.options) {
    fail(
      node.at,
      `<Choice> has ${options.length} options; the limit is ${UI_MARKUP_LIMITS.options}`,
    );
  }

  return { type: "choice", layout, multiple, options };
}

function choiceLayout(node: RawElement): "list" | "row" {
  const value = stringAttribute(node, "layout", 20);
  if (value === null) return "list";
  if (value === "list" || value === "row") return value;
  fail(node.at, `unknown layout "${value}" (use list or row)`);
}

function buildForm(node: RawElement, scope: Scope): UiFormBlock {
  checkAttributes(node, ["submit"]);
  const submit = contentAttribute(
    node,
    "submit",
    UI_MARKUP_LIMITS.submitChars,
    scope,
  );
  const fields = elementChildren(node, ["Field"]).map((field) =>
    readField(field, scope),
  );

  if (fields.length === 0) fail(node.at, "<Form> needs at least one <Field>");
  if (fields.length > UI_MARKUP_LIMITS.fields) {
    fail(
      node.at,
      `<Form> has ${fields.length} fields; the limit is ${UI_MARKUP_LIMITS.fields}`,
    );
  }

  return { type: "form", submit, fields };
}

function readField(node: RawElement, scope: Scope): UiField {
  checkAttributes(node, ["label", "type", "required", "placeholder"]);

  const label = requiredContentAttribute(
    node,
    "label",
    UI_MARKUP_LIMITS.fieldLabelChars,
    scope,
  );
  const type = fieldType(node);
  const required = flagAttribute(node, "required");
  const placeholder = contentAttribute(
    node,
    "placeholder",
    UI_MARKUP_LIMITS.placeholderChars,
    scope,
  );
  const description = fieldDescription(node, scope);

  if (type === "select") {
    const options = readOptions(node, scope);
    if (options.length === 0) {
      fail(node.at, '<Field type="select"> needs at least one <Option>');
    }
    if (options.length > UI_MARKUP_LIMITS.selectOptions) {
      fail(
        node.at,
        `<Field> has ${options.length} options; the limit is ` +
          `${UI_MARKUP_LIMITS.selectOptions}`,
      );
    }
    return { label, type, required, placeholder, description, options };
  }

  noElements(node);
  return { label, type, required, placeholder, description, options: [] };
}

/**
 * The `<Field>`'s own text: a line drawn under the input that says what to
 * write there ("毎週の曜日と時間帯を書いてください").
 *
 * The model writes it where a person writing HTML would write a label's help
 * text — between the tags — so that is where the grammar reads it. It is not
 * the placeholder: a placeholder is an example value that disappears as soon
 * as the reader types.
 */
function fieldDescription(node: RawElement, scope: Scope): string | null {
  let raw = "";
  for (const child of node.children) {
    if (child.kind === "text") raw += child.text;
  }

  const text = normalizeText(raw);
  if (text.length === 0) return null;
  if (text.length > UI_MARKUP_LIMITS.fieldDescriptionChars) {
    fail(
      node.at,
      `the text of <Field> is ${text.length} characters; the limit is ` +
        `${UI_MARKUP_LIMITS.fieldDescriptionChars}`,
    );
  }
  checkReferences(text, node.at, scope);
  return text;
}

function fieldType(node: RawElement): UiFieldType {
  const value = stringAttribute(node, "type", 20);
  if (value === null) return "text";
  if (
    value === "text" ||
    value === "number" ||
    value === "select" ||
    value === "checkbox"
  ) {
    return value;
  }
  fail(
    node.at,
    `unknown field type "${value}" (use text, number, select or checkbox)`,
  );
}

function readOptions(node: RawElement, scope: Scope): UiOption[] {
  const options: RawElement[] = [];
  for (const child of node.children) {
    // The field's own text is its description (see fieldDescription).
    if (child.kind === "text") continue;
    if (child.name !== "Option") {
      fail(
        child.at,
        `<${child.name}> is not allowed inside <Field> (allowed: Option)`,
      );
    }
    options.push(child);
  }
  return options.map((option) => {
    checkAttributes(option, ["description"]);
    return {
      label: contentText(
        option,
        UI_MARKUP_LIMITS.optionLabelChars,
        "an option label",
        scope,
      ),
      description: contentAttribute(
        option,
        "description",
        UI_MARKUP_LIMITS.optionDescriptionChars,
        scope,
      ),
    };
  });
}

function gapAttribute(node: RawElement): UiGap {
  const value = stringAttribute(node, "gap", 20);
  if (value === null) return "m";
  if (value === "s" || value === "m" || value === "l") return value;
  fail(node.at, `unknown gap "${value}" (use s, m or l)`);
}

function numberAttribute(node: RawElement, name: string): number | null {
  const value = stringAttribute(node, name, 20);
  if (value === null) return null;
  if (!/^[0-9]+$/.test(value)) {
    fail(node.at, `attribute "${name}" of <${node.name}> must be a number`);
  }
  return Number(value);
}

// --- blocks and their bounds ------------------------------------------------

/** Every block written, containers and binds included. */
function countBlocks(blocks: readonly UiBlock[]): number {
  let total = 0;
  for (const block of blocks) {
    total += 1;
    if (block.type === "stack" || block.type === "columns") {
      total += countBlocks(block.blocks);
    } else if (block.type === "grid") {
      total += countBlocks(block.blocks);
    } else if (block.type === "repeat" || block.type === "if") {
      total += countBlocks(block.blocks);
    }
  }
  return total;
}

/** The blocks the screen draws once the repeats are expanded.
 *
 * An `<If>` is counted as drawn: whether it is depends on an item, and the
 * bound has to hold for every item the card could carry. */
function expandedBlocks(blocks: readonly UiBlock[], data: UiData): number {
  let total = 0;
  for (const block of blocks) {
    if (block.type === "repeat") {
      const value = valueAt(data, block.over);
      const items = Array.isArray(value.value) ? value.value.length : 0;
      total += items * expandedBlocks(block.blocks, data);
      continue;
    }
    if (block.type === "stack" || block.type === "columns") {
      total += 1 + expandedBlocks(block.blocks, data);
      continue;
    }
    if (block.type === "grid") {
      total += 1 + expandedBlocks(block.blocks, data);
      continue;
    }
    if (block.type === "if") {
      total += expandedBlocks(block.blocks, data);
      continue;
    }
    total += 1;
  }
  return total;
}

function interactiveCount(blocks: readonly UiBlock[]): number {
  let total = 0;
  for (const block of blocks) {
    if (block.type === "choice" || block.type === "form") {
      total += 1;
      continue;
    }
    if (
      block.type === "stack" ||
      block.type === "columns" ||
      block.type === "grid" ||
      block.type === "repeat" ||
      block.type === "if"
    ) {
      total += interactiveCount(block.blocks);
    }
  }
  return total;
}

// --- references -------------------------------------------------------------

/** A path into the card's data: dotted keys, no brackets. */
function checkPath(path: string, at: number): void {
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path)) {
    fail(at, `"${path}" is not a data path (write it as keys joined by dots)`);
  }
  if (path.length > UI_MARKUP_LIMITS.dataPathChars) {
    fail(at, `the path "${path}" is too long`);
  }
}

/** One `$` of a content string, as the string itself reads it. */
export type UiSpan = {
  /** `"$"` for the `$$` escape; the keyword otherwise. */
  kind: "$" | "item" | "index" | "data";
  /** The path after the keyword, without its leading dot ("" for `$item`). */
  path: string;
  /** Index of the `$` in the string. */
  start: number;
  /** Index just past the span. */
  end: number;
};

/**
 * The spans of a content string that are references, or an escaped `$`.
 *
 * A `$` is a reference only when it spells `$item`, `$index` or `$data` and
 * that name ends there. Every other `$` is text — a price ("$5"), a shell
 * variable ("$XDG_CONFIG_HOME"), a template literal — and asking the model to
 * write `$$` for those made a sentence that mentions one unable to draw.
 *
 * The reader (`checkReferences`) and the screen (`resolve.ts`) both walk a
 * string with this one function: what was checked is exactly what is
 * replaced.
 */
export function* referenceSpans(value: string): Generator<UiSpan> {
  let index = 0;
  while (index < value.length) {
    const dollar = value.indexOf("$", index);
    if (dollar < 0) return;
    const rest = value.slice(dollar);

    if (rest.startsWith("$$")) {
      yield { kind: "$", path: "", start: dollar, end: dollar + 2 };
      index = dollar + 2;
      continue;
    }

    const match = /^\$(item|index|data)((?:\.[A-Za-z0-9_-]+)*)/.exec(rest);
    if (match === null) {
      index = dollar + 1;
      continue;
    }
    const end = dollar + match[0].length;
    if (/[A-Za-z0-9_-]/.test(value[end] ?? "")) {
      // `$items` or `$database` spells a word, not the keyword.
      index = end;
      continue;
    }

    yield {
      kind: match[1] as "item" | "index" | "data",
      path: (match[2] ?? "").replace(/^\./, ""),
      start: dollar,
      end,
    };
    index = end;
  }
}

/**
 * Check the references a content string carries.
 *
 * Everything is checked against the values the card carried: `$data.x` must
 * exist in `<Data>`, `$item.x` must exist on every item of the enclosing
 * repeat, and `$index` must have a repeat to count. What is written but not
 * known is a mistake the model can fix now, instead of a blank line the
 * reader cannot explain.
 */
function checkReferences(value: string, at: number, scope: Scope): void {
  for (const span of referenceSpans(value)) {
    if (span.kind === "$") continue;

    if (span.kind === "index") {
      if (scope.items === null) {
        fail(at, "$index can only be used inside a <Repeat>");
      }
      continue;
    }

    if (span.kind === "item") {
      if (scope.items === null) {
        fail(at, "$item can only be used inside a <Repeat>");
      }
      // An empty path is the item itself; assertFieldOnItems checks it is a
      // value the screen can print, on every item.
      assertFieldOnItems(span.path, at, scope);
      continue;
    }

    if (span.path.length === 0) {
      fail(at, "$data needs a field, e.g. $data.total");
    }
    const found = valueAt(scope.data, span.path);
    if (!found.found) {
      fail(at, `$data.${span.path} names no field of <Data>`);
    }
    if (!isScalar(found.value)) {
      fail(at, `$data.${span.path} must be text, a number or true/false`);
    }
  }
}

/** Resolve a dotted path in the card's data. Only own keys are read, so a
 * path can never reach an object the card did not carry. */
export function valueAt(
  root: unknown,
  path: string,
): { found: boolean; value: unknown } {
  if (path.length === 0) return { found: true, value: root };

  let current = root;
  for (const key of path.split(".")) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      return { found: false, value: undefined };
    }
    if (!Object.hasOwn(current, key)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

function isScalar(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

// --- attributes -------------------------------------------------------------

/** Check the attributes the tag accepts. */
function checkAttributes(node: RawElement, allowed: readonly string[]): void {
  for (const attribute of node.attrs) {
    if (allowed.includes(attribute.name)) continue;

    const hint =
      allowed.length === 0
        ? "it takes no attributes"
        : `allowed: ${allowed.join(", ")}`;
    fail(
      attribute.at,
      `<${node.name}> does not take the attribute "${attribute.name}" (${hint})`,
    );
  }
}

/** An attribute that carries a value; null when it is not written. */
function stringAttribute(
  node: RawElement,
  name: string,
  maxChars: number,
): string | null {
  const attribute = node.attrs.find((entry) => entry.name === name);
  if (attribute === undefined) return null;
  if (attribute.value === null) {
    fail(
      attribute.at,
      `attribute "${name}" of <${node.name}> needs a value in double quotes`,
    );
  }

  const value = attribute.value.trim();
  if (value.length === 0) {
    fail(attribute.at, `attribute "${name}" of <${node.name}> is empty`);
  }
  if (value.length > maxChars) {
    fail(
      attribute.at,
      `attribute "${name}" is ${value.length} characters; the limit is ${maxChars}`,
    );
  }
  return value;
}

/** A value-carrying attribute whose text may read the card's data. */
function contentAttribute(
  node: RawElement,
  name: string,
  maxChars: number,
  scope: Scope,
): string | null {
  const value = stringAttribute(node, name, maxChars);
  if (value === null) return null;
  const attribute = node.attrs.find((entry) => entry.name === name);
  checkReferences(value, attribute?.at ?? node.at, scope);
  return value;
}

/** A value-carrying attribute that must be written. */
function requiredAttribute(
  node: RawElement,
  name: string,
  maxChars: number,
): string {
  const value = stringAttribute(node, name, maxChars);
  if (value === null) {
    fail(node.at, `<${node.name}> needs the attribute "${name}"`);
  }
  return value;
}

function requiredContentAttribute(
  node: RawElement,
  name: string,
  maxChars: number,
  scope: Scope,
): string {
  const value = contentAttribute(node, name, maxChars, scope);
  if (value === null) {
    fail(node.at, `<${node.name}> needs the attribute "${name}"`);
  }
  return value;
}

/** A boolean attribute: bare, or given a value of `"true"` / `"false"`.
 *
 * A model trained on HTML writes `multiple` and `multiple="true"` both, and
 * a wrong guess used to be a card that would not draw. Both spellings say the
 * same one thing; any other value is still refused, because guessing what
 * `multiple="yes"` meant is not this reader's job. */
function flagAttribute(node: RawElement, name: string): boolean {
  const attribute = node.attrs.find((entry) => entry.name === name);
  if (attribute === undefined) return false;
  if (attribute.value === null || attribute.value === "true") return true;
  if (attribute.value === "false") return false;
  fail(
    attribute.at,
    `attribute "${name}" of <${node.name}> is either written bare or given ` +
      '"true" or "false"',
  );
}

/** Take out only the text inside the tag. A mixed-in element is refused at its
 * position. */
function textContent(node: RawElement, maxChars: number, what: string): string {
  let raw = "";
  for (const child of node.children) {
    if (child.kind === "element") {
      fail(
        child.at,
        `<${node.name}> can only contain text; <${child.name}> is not allowed inside it`,
      );
    }
    raw += child.text;
  }

  const text = normalizeText(raw);
  if (text.length === 0) fail(node.at, `${what} is empty`);
  if (text.length > maxChars) {
    fail(
      node.at,
      `${what} is ${text.length} characters; the limit is ${maxChars}`,
    );
  }
  return text;
}

/** Text that may read the card's data. */
function contentText(
  node: RawElement,
  maxChars: number,
  what: string,
  scope: Scope,
): string {
  const text = textContent(node, maxChars, what);
  checkReferences(text, node.at, scope);
  return text;
}

/** Take out only the child elements, refusing wrapped text and unknown
 * tags. */
function elementChildren(
  node: RawElement,
  allowed: readonly string[],
): RawElement[] {
  const elements: RawElement[] = [];

  for (const child of node.children) {
    if (child.kind === "text") {
      if (child.text.trim().length === 0) continue;
      const hint = allowed[0] === undefined ? "" : `; use <${allowed[0]}>`;
      fail(
        child.at,
        `text is not allowed directly inside <${node.name}>${hint}`,
      );
    }
    if (!allowed.includes(child.name)) {
      const hint =
        allowed.length === 0 ? "" : ` (allowed: ${allowed.join(", ")})`;
      fail(
        child.at,
        `<${child.name}> is not allowed inside <${node.name}>${hint}`,
      );
    }
    elements.push(child);
  }

  return elements;
}

/** A tag that must have no content (Edge and the like). */
function noContent(node: RawElement): void {
  for (const child of node.children) {
    if (child.kind === "element") {
      fail(child.at, `<${node.name}> has no child elements`);
    }
    if (child.text.trim().length > 0) {
      fail(child.at, `<${node.name}> has no content`);
    }
  }
}

/** A tag whose text is allowed but whose elements are not. */
function noElements(node: RawElement): void {
  for (const child of node.children) {
    if (child.kind !== "element") continue;
    const hint =
      child.name === "Option" ? ' (<Option> needs type="select")' : "";
    fail(child.at, `<${node.name}> cannot hold <${child.name}>${hint}`);
  }
}

/**
 * Tidy up the text inside a tag.
 * Leading and trailing blank lines go, and so does the indentation the
 * markup was written with (the one every line shares).
 */
function normalizeText(raw: string): string {
  const lines = raw.split("\n");
  while (lines.length > 0 && (lines[0] ?? "").trim().length === 0) {
    lines.shift();
  }
  while (
    lines.length > 0 &&
    (lines[lines.length - 1] ?? "").trim().length === 0
  ) {
    lines.pop();
  }
  if (lines.length === 0) return "";

  let indent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    indent = Math.min(indent, line.length - line.trimStart().length);
  }

  const dedented = lines.map((line) =>
    line.trim().length === 0 ? "" : line.slice(indent),
  );
  return dedented.join("\n").trim();
}

/**
 * Read the markup into the grammar's card.
 * The length limit and the position of a reading error are handled here,
 * once.
 */
export function parseUiMarkup(source: string): UiParseResult {
  const text = source.replace(/\r\n/g, "\n");
  if (text.trim().length === 0) {
    return { ok: false, problem: "the markup is empty; it needs one <Card>" };
  }
  if (text.length > UI_MARKUP_LIMITS.chars) {
    return {
      ok: false,
      problem: `the markup is ${text.length} characters; the limit is ${UI_MARKUP_LIMITS.chars}`,
    };
  }

  try {
    return { ok: true, view: buildView(parseDocument(text)) };
  } catch (error) {
    if (!(error instanceof MarkupError)) throw error;
    const { line, column } = positionOf(text, error.at);
    return {
      ok: false,
      problem: `line ${line}, column ${column}: ${error.message}`,
    };
  }
}

/**
 * Read a card that is still being written: the strict parse when it already
 * is whole, otherwise the blocks that have closed so far.
 *
 * This is what the screen draws while the model writes a card into its reply
 * (see ./segments.ts). When nothing is readable yet the strict parse's
 * problem is returned, so a card that is genuinely wrong still says why once
 * it is complete.
 */
export function parseUiMarkupPartial(source: string): UiParseResult {
  const full = parseUiMarkup(source);
  if (full.ok) return full;
  const prefix = cardPrefix(source);
  if (prefix === null) return full;
  const partial = parseUiMarkup(prefix);
  return partial.ok ? partial : full;
}
