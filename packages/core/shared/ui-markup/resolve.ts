import { referenceSpans, valueAt } from "./build.ts";
import type {
  UiBlock,
  UiCondition,
  UiContentBlock,
  UiData,
  UiResolvedBlock,
  UiResolvedView,
  UiView,
} from "./types.ts";

/**
 * Expand a parsed card into the blocks the screen draws.
 *
 * A parse keeps the binds as written (see types.ts); this is the one place
 * that turns them into literal text, by walking the tree once with the card's
 * own data. Every reference was checked against that data when the card was
 * read, so a walk that meets an unknown one is a mistake in this module, not
 * in the card: it throws rather than drawing a blank line.
 */

/** The item being repeated, while a `<Repeat>` subtree is walked. */
type Context = {
  readonly item: unknown;
  readonly index: number;
} | null;

export function resolveUiView(view: UiView): UiResolvedView {
  return {
    title: view.title === null ? null : substitute(view.title, view.data, null),
    blocks: resolveBlocks(view.blocks, view.data, null),
  };
}

function resolveBlocks(
  blocks: readonly UiBlock[],
  data: UiData,
  context: Context,
): UiResolvedBlock[] {
  const resolved: UiResolvedBlock[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "repeat": {
        const value = valueAt(data, block.over);
        const items: readonly unknown[] = Array.isArray(value.value)
          ? value.value
          : [];
        items.forEach((item, index) => {
          resolved.push(...resolveBlocks(block.blocks, data, { item, index }));
        });
        break;
      }

      case "if": {
        if (context === null) {
          throw new Error("<If> resolved outside a <Repeat>");
        }
        if (matches(block.condition, context.item)) {
          resolved.push(...resolveBlocks(block.blocks, data, context));
        }
        break;
      }

      case "stack":
      case "columns":
      case "grid":
        resolved.push({
          ...block,
          blocks: resolveBlocks(block.blocks, data, context),
        });
        break;

      default:
        resolved.push(resolveContent(block, data, context));
    }
  }

  return resolved;
}

function resolveContent(
  block: UiContentBlock,
  data: UiData,
  context: Context,
): UiContentBlock {
  const text = (value: string) => substitute(value, data, context);
  const optional = (value: string | null) =>
    value === null ? null : text(value);

  switch (block.type) {
    case "text":
      return { type: "text", text: text(block.text) };

    case "list":
      return {
        type: "list",
        ordered: block.ordered,
        items: block.items.map(text),
      };

    case "table":
      return {
        type: "table",
        rows: block.rows.map((row) => row.map(text)),
      };

    case "metric":
      return {
        type: "metric",
        label: text(block.label),
        value: text(block.value),
        unit: optional(block.unit),
        hint: optional(block.hint),
      };

    case "flow":
      return {
        type: "flow",
        nodes: block.nodes.map((node) => ({
          ...node,
          label: text(node.label),
        })),
        edges: block.edges.map((edge) => ({
          ...edge,
          label: optional(edge.label),
        })),
      };

    case "choice":
      return {
        type: "choice",
        layout: block.layout,
        multiple: block.multiple,
        options: block.options.map((option) => ({
          label: text(option.label),
          description: optional(option.description),
        })),
      };

    case "form":
      return {
        type: "form",
        submit: optional(block.submit),
        fields: block.fields.map((field) => ({
          label: text(field.label),
          type: field.type,
          required: field.required,
          placeholder: optional(field.placeholder),
          description: optional(field.description),
          options: field.options.map((option) => ({
            label: text(option.label),
            description: optional(option.description),
          })),
        })),
      };
  }
}

function matches(condition: UiCondition, item: unknown): boolean {
  const value = String(valueAt(item, condition.field).value);
  if (condition.eq !== null) return value === condition.eq;
  if (condition.ne !== null) return value !== condition.ne;
  throw new Error("<If> has neither eq nor ne");
}

/** Replace the references in a content string. `$$` stands for one `$`. */
function substitute(value: string, data: UiData, context: Context): string {
  if (!value.includes("$")) return value;

  let out = "";
  let cursor = 0;
  for (const span of referenceSpans(value)) {
    out += value.slice(cursor, span.start);

    if (span.kind === "$") {
      out += "$";
    } else if (span.kind === "index") {
      if (context === null) throw new Error("$index outside a <Repeat>");
      out += String(context.index);
    } else if (span.kind === "item") {
      if (context === null) throw new Error("$item outside a <Repeat>");
      out += String(valueAt(context.item, span.path).value);
    } else {
      out += String(valueAt(data, span.path).value);
    }

    cursor = span.end;
  }

  return out + value.slice(cursor);
}
