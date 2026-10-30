import { UI_MARKUP_LIMITS } from "./limits.ts";
import {
  ALL_TAGS,
  BLOCK_TAGS,
  fail,
  MarkupError,
  parseDocument,
  positionOf,
  type RawElement,
} from "./reader.ts";
import type {
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
  UiView,
} from "./types.ts";

/** Rearrange the tree of tags into the grammar's card. */

function buildView(root: RawElement): UiView {
  if (root.name !== "Card") {
    fail(root.at, `the root must be <Card>, not <${root.name}>`);
  }

  checkAttributes(root, ["title"]);
  const title = stringAttribute(root, "title", UI_MARKUP_LIMITS.titleChars);

  const nodes = elementChildren(root, BLOCK_TAGS);
  if (nodes.length === 0) fail(root.at, "<Card> needs at least one block");
  if (nodes.length > UI_MARKUP_LIMITS.blocks) {
    fail(
      root.at,
      `<Card> has ${nodes.length} blocks; the limit is ${UI_MARKUP_LIMITS.blocks}`,
    );
  }

  const blocks = nodes.map(buildBlock);
  const interactive =
    blocks.filter((block) => block.type === "choice" || block.type === "form")
      .length;
  if (interactive > 1) {
    fail(root.at, "a card can have at most one <Choice> or <Form>");
  }

  return { title, blocks };
}

function buildBlock(node: RawElement): UiBlock {
  switch (node.name) {
    case "Text":
      checkAttributes(node, []);
      return {
        type: "text",
        text: textContent(node, UI_MARKUP_LIMITS.textChars, "the text"),
      };

    case "List":
      return buildList(node);

    case "Table":
      return buildTable(node);

    case "Flow":
      return buildFlow(node);

    case "Choice":
      return buildChoice(node);

    case "Form":
      return buildForm(node);

    default:
      fail(
        node.at,
        `unknown tag <${node.name}> (allowed: ${ALL_TAGS.join(", ")})`,
      );
  }
}

function buildList(node: RawElement): UiListBlock {
  checkAttributes(node, ["ordered"]);
  const ordered = flagAttribute(node, "ordered");
  const items = elementChildren(node, ["Item"]).map((item) => {
    checkAttributes(item, []);
    return textContent(item, UI_MARKUP_LIMITS.listItemChars, "a list item");
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

function buildTable(node: RawElement): UiTableBlock {
  checkAttributes(node, []);

  const rows = elementChildren(node, ["Row"]).map((row) => {
    checkAttributes(row, []);
    const cells = elementChildren(row, ["Cell"]).map((cell) => {
      checkAttributes(cell, []);
      return textContent(cell, UI_MARKUP_LIMITS.tableCellChars, "a table cell");
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

function buildFlow(node: RawElement): UiFlowBlock {
  checkAttributes(node, []);

  const nodes: UiFlowNode[] = [];
  const edges: { at: number; edge: UiFlowEdge }[] = [];

  for (const element of elementChildren(node, ["Node", "Edge"])) {
    if (element.name === "Node") {
      nodes.push(readFlowNode(element, nodes));
      continue;
    }
    edges.push(readFlowEdge(element));
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
  const label = textContent(
    node,
    UI_MARKUP_LIMITS.flowLabelChars,
    `the label of node "${id}"`,
  );
  return { id, label, shape };
}

function flowShape(node: RawElement): UiFlowShape {
  const value = stringAttribute(node, "shape", 20);
  if (value === null) return "box";
  if (
    value === "box" || value === "round" || value === "diamond" ||
    value === "pill"
  ) {
    return value;
  }
  fail(node.at, `unknown shape "${value}" (use box, round, diamond or pill)`);
}

function readFlowEdge(node: RawElement): { at: number; edge: UiFlowEdge } {
  checkAttributes(node, ["from", "to", "label", "dashed"]);
  noContent(node);

  const from = requiredAttribute(node, "from", UI_MARKUP_LIMITS.nodeIdChars);
  const to = requiredAttribute(node, "to", UI_MARKUP_LIMITS.nodeIdChars);
  if (from === to) fail(node.at, "an <Edge> must connect two different nodes");

  const label = stringAttribute(
    node,
    "label",
    UI_MARKUP_LIMITS.flowEdgeLabelChars,
  );
  return {
    at: node.at,
    edge: { from, to, label, dashed: flagAttribute(node, "dashed") },
  };
}

function buildChoice(node: RawElement): UiChoiceBlock {
  checkAttributes(node, ["multiple"]);
  const multiple = flagAttribute(node, "multiple");
  const options = readOptions(node);

  if (options.length < 2) fail(node.at, "<Choice> needs at least two <Option>");
  if (options.length > UI_MARKUP_LIMITS.options) {
    fail(
      node.at,
      `<Choice> has ${options.length} options; the limit is ${UI_MARKUP_LIMITS.options}`,
    );
  }

  return { type: "choice", multiple, options };
}

function buildForm(node: RawElement): UiFormBlock {
  checkAttributes(node, ["submit"]);
  const submit = stringAttribute(node, "submit", UI_MARKUP_LIMITS.submitChars);
  const fields = elementChildren(node, ["Field"]).map(readField);

  if (fields.length === 0) fail(node.at, "<Form> needs at least one <Field>");
  if (fields.length > UI_MARKUP_LIMITS.fields) {
    fail(
      node.at,
      `<Form> has ${fields.length} fields; the limit is ${UI_MARKUP_LIMITS.fields}`,
    );
  }

  return { type: "form", submit, fields };
}

function readField(node: RawElement): UiField {
  checkAttributes(node, ["label", "type", "required", "placeholder"]);

  const label = requiredAttribute(
    node,
    "label",
    UI_MARKUP_LIMITS.fieldLabelChars,
  );
  const type = fieldType(node);
  const required = flagAttribute(node, "required");
  const placeholder = stringAttribute(
    node,
    "placeholder",
    UI_MARKUP_LIMITS.placeholderChars,
  );

  if (type === "select") {
    const options = readOptions(node);
    if (options.length === 0) {
      fail(node.at, '<Field type="select"> needs at least one <Option>');
    }
    if (options.length > UI_MARKUP_LIMITS.selectOptions) {
      fail(
        node.at,
        `<Field> has ${options.length} options; the limit is ${UI_MARKUP_LIMITS.selectOptions}`,
      );
    }
    return { label, type, required, placeholder, options };
  }

  noContent(node);
  return { label, type, required, placeholder, options: [] };
}

function fieldType(node: RawElement): UiFieldType {
  const value = stringAttribute(node, "type", 20);
  if (value === null) return "text";
  if (
    value === "text" || value === "number" || value === "select" ||
    value === "checkbox"
  ) {
    return value;
  }
  fail(
    node.at,
    `unknown field type "${value}" (use text, number, select or checkbox)`,
  );
}

function readOptions(node: RawElement): UiOption[] {
  return elementChildren(node, ["Option"]).map((option) => {
    checkAttributes(option, ["description"]);
    return {
      label: textContent(
        option,
        UI_MARKUP_LIMITS.optionLabelChars,
        "an option label",
      ),
      description: stringAttribute(
        option,
        "description",
        UI_MARKUP_LIMITS.optionDescriptionChars,
      ),
    };
  });
}

/** Check the attributes the tag accepts. */
function checkAttributes(node: RawElement, allowed: readonly string[]): void {
  for (const attribute of node.attrs) {
    if (allowed.includes(attribute.name)) continue;

    const hint = allowed.length === 0
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

/** A value-less boolean attribute. */
function flagAttribute(node: RawElement, name: string): boolean {
  const attribute = node.attrs.find((entry) => entry.name === name);
  if (attribute === undefined) return false;
  if (attribute.value !== null) {
    fail(
      attribute.at,
      `attribute "${name}" of <${node.name}> takes no value`,
    );
  }
  return true;
}

/** An attribute that must be written with a value. */
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
      const hint = allowed.length === 0
        ? ""
        : ` (allowed: ${allowed.join(", ")})`;
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
    lines.length > 0 && (lines[lines.length - 1] ?? "").trim().length === 0
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
    line.trim().length === 0 ? "" : line.slice(indent)
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
      problem:
        `the markup is ${text.length} characters; the limit is ${UI_MARKUP_LIMITS.chars}`,
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
