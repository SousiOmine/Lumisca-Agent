import type { Tool, ToolSchema } from "./schema.ts";

/**
 * The character budget for the initial-tool declarations. Twelve thousand
 * characters is about three thousand tokens at four characters per token,
 * the same budget pi's codemode uses for its inline declarations. A tool that
 * does not fit keeps its name and loses its description or schema; the full
 * schema remains available through tool_search.
 */
export const MAX_TOOL_SDK_CHARS = 12_000;

/** One line of a tool description in the declaration. */
const DESCRIPTION_MAX_CHARS = 160;

function identifier(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function descriptionOf(tool: Tool): string {
  const text = tool.description
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\*\//g, "*\\/");
  if (text.length === 0) return "";
  const shortened =
    text.length > DESCRIPTION_MAX_CHARS
      ? text.slice(0, DESCRIPTION_MAX_CHARS - 1) + "…"
      : text;
  return "/** " + shortened + " */";
}

function typeOf(schema: ToolSchema, simplify: boolean): string {
  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "Array<" + typeOf(schema.items, simplify) + ">";
    case "object":
      return objectType(schema, simplify);
  }
  return "unknown";
}

function objectType(
  schema: Extract<ToolSchema, { type: "object" }>,
  simplify: boolean,
): string {
  if ("properties" in schema) {
    if (simplify || Object.keys(schema.properties).length === 0) {
      return "Record<string, unknown>";
    }
    const required = new Set<string>(schema.required);
    const fields: string[] = [];
    for (const [key, child] of Object.entries(schema.properties)) {
      fields.push(
        identifier(key) +
          (required.has(key) ? "" : "?") +
          ": " +
          typeOf(child, simplify),
      );
    }
    const base = "{ " + fields.join("; ") + " }";
    return schema.additionalProperties === true
      ? base + " & Record<string, unknown>"
      : base;
  }
  return (
    "Record<string, " + typeOf(schema.additionalProperties, simplify) + ">"
  );
}

function argsOf(parameters: ToolSchema, simplify: boolean): string {
  if (parameters.type !== "object") return "args: unknown";
  if (!("properties" in parameters)) {
    return (
      "args: Record<string, " +
      typeOf(parameters.additionalProperties, simplify) +
      ">"
    );
  }
  if (Object.keys(parameters.properties).length === 0) {
    return parameters.additionalProperties === true
      ? "args: Record<string, unknown>"
      : "";
  }
  return "args: " + objectType(parameters, simplify);
}

function render(
  tools: readonly Tool[],
  includeDescriptions: boolean,
  simplify: boolean,
): string {
  const sorted = [...tools].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const lines: string[] = [
    "// Tools declared here are available without a search.",
    "// Tools not declared here are found with tools.tool_search({ query }).",
    "declare const tools: {",
  ];
  for (const tool of sorted) {
    if (includeDescriptions) {
      const description = descriptionOf(tool);
      if (description.length > 0) lines.push("  " + description);
    }
    lines.push(
      "  " +
        identifier(tool.name) +
        "(" +
        argsOf(tool.parameters, simplify) +
        "): Promise<string>;",
    );
  }
  lines.push("};");
  lines.push("");
  lines.push("/** Write a small JSON value; undefined deletes it. */");
  lines.push("declare function store(key: string, value: unknown): void;");
  lines.push("/** Read a value written by store; returns a copy. */");
  lines.push("declare function load(key: string): unknown;");
  return lines.join("\n");
}

/**
 * The TypeScript declarations of the tools a program may call without a
 * search. Every tool keeps its name; descriptions and large schemas are
 * dropped first when the budget is exceeded, because a name the model can
 * call is worth more than a description it can also get from tool_search.
 */
export function renderToolSdk(tools: readonly Tool[]): string {
  const unique = new Map<string, Tool>();
  for (const tool of tools) {
    if (!unique.has(tool.name)) unique.set(tool.name, tool);
  }
  const all = [...unique.values()];
  const withDescriptions = render(all, true, false);
  if (withDescriptions.length <= MAX_TOOL_SDK_CHARS) return withDescriptions;
  const withoutDescriptions = render(all, false, false);
  if (withoutDescriptions.length <= MAX_TOOL_SDK_CHARS) {
    return withoutDescriptions;
  }
  return render(all, false, true);
}
