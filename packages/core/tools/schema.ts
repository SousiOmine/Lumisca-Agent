/**
 * Tool schema DSL: plain JSON Schema with type-level inference.
 *
 * Deliberately independent of pi-ai (which re-exports TypeBox): tool
 * schemas are plain JSON Schema objects, which pi's validateToolArguments
 * accepts directly (it explicitly supports schemas without TypeBox Kind
 * markers — manual coercion + Ajv validation). Keeping this module free of
 * pi imports confines the pi-ai dependency to the adapter and the agent
 * boundary.
 */

// --- schema types ----------------------------------------------------------

export interface SchemaString {
  type: "string";
  description?: string;
}

export interface SchemaInteger {
  type: "integer";
  description?: string;
}

export interface SchemaBoolean {
  type: "boolean";
  description?: string;
}

export interface SchemaArray<I extends ToolSchema = ToolSchema> {
  type: "array";
  items: I;
  description?: string;
}

export interface SchemaObject<
  P extends Record<string, ToolSchema> = Record<string, ToolSchema>,
> {
  type: "object";
  properties: P;
  /** Keys that must be present (JSON Schema `required`), computed from the
   * `optional()` markers at build time. */
  required: Array<keyof P & string>;
  /** `true` = arbitrary additional properties (e.g. MCP tool arguments,
   * whose schemas are delegated to the remote server). */
  additionalProperties?: true;
  description?: string;
}

/** An object whose values are all strings — e.g. environment variables.
 * Plain JSON Schema: `{ type: "object", additionalProperties: { type:
 * "string" } }`. */
export interface SchemaStringMap {
  type: "object";
  additionalProperties: SchemaString;
  description?: string;
}

export type ToolSchema =
  | SchemaString
  | SchemaInteger
  | SchemaBoolean
  | SchemaArray
  | SchemaObject
  | SchemaStringMap;

// --- optional marker ----------------------------------------------------------

/** Marker carried by `optional()` schemas; stripped by `object()` before
 * the schema is exposed, so it never reaches JSON serialization. */
const OPTIONAL: unique symbol = Symbol("optional");
type OptionalMarker = { [OPTIONAL]: true };

export type SchemaOptional<S extends ToolSchema> = S & OptionalMarker;

type IsOptional<S extends ToolSchema> = S extends OptionalMarker ? true : false;

/** Mark a property as optional. Keys without the marker are required. */
export function optional<S extends ToolSchema>(schema: S): SchemaOptional<S> {
  return Object.assign({}, schema, { [OPTIONAL]: true }) as SchemaOptional<S>;
}

/** The TypeScript type a validated argument object has. Properties wrapped
 * in `optional()` become optional (`?`), matching the call sites' null
 * checks. */
export type Infer<S extends ToolSchema> = S extends SchemaObject<infer P> ?
    & {
      [K in keyof P as IsOptional<P[K]> extends true ? never : K]: Infer<P[K]>;
    }
    & {
      [K in keyof P as IsOptional<P[K]> extends true ? K : never]?: Infer<P[K]>;
    }
    & (S extends { additionalProperties: true } ? Record<string, unknown>
      : unknown)
  : S extends SchemaStringMap ? Record<string, string>
  : S extends SchemaArray<infer I> ? Array<Infer<I>>
  : S extends SchemaString ? string
  : S extends SchemaInteger ? number
  : S extends SchemaBoolean ? boolean
  : never;

// --- builders ----------------------------------------------------------------

export function string(description?: string): SchemaString {
  return description === undefined
    ? { type: "string" }
    : { type: "string", description };
}

export function integer(description?: string): SchemaInteger {
  return description === undefined
    ? { type: "integer" }
    : { type: "integer", description };
}

export function boolean(description?: string): SchemaBoolean {
  return description === undefined
    ? { type: "boolean" }
    : { type: "boolean", description };
}

export function array<I extends ToolSchema>(
  items: I,
  description?: string,
): SchemaArray<I> {
  return description === undefined
    ? { type: "array", items }
    : { type: "array", items, description };
}

/** An object whose values are all strings — e.g. environment variables. */
export function stringMap(description?: string): SchemaStringMap {
  return description === undefined
    ? { type: "object", additionalProperties: string() }
    : { type: "object", additionalProperties: string(), description };
}

/** Build an object schema. The returned `properties` have the optional
 * markers stripped; `required` lists every non-optional key. */
export function object<P extends Record<string, ToolSchema>>(
  properties: P,
  options: {
    additionalProperties?: true;
    description?: string;
  } = {},
): SchemaObject<P> {
  const required: string[] = [];
  const clean: Record<string, ToolSchema> = {};
  for (const [key, schema] of Object.entries(properties)) {
    if (OPTIONAL in schema) {
      const rest = { ...schema };
      delete (rest as Record<PropertyKey, unknown>)[OPTIONAL];
      clean[key] = rest as ToolSchema;
    } else {
      clean[key] = schema;
      required.push(key);
    }
  }
  return {
    type: "object",
    properties: clean as P,
    required,
    ...(options.additionalProperties === true
      ? { additionalProperties: true }
      : {}),
    ...(options.description !== undefined
      ? { description: options.description }
      : {}),
  };
}

// --- tool interface -----------------------------------------------------------

/** A content block of a tool result: text, or an image (base64 `data`).
 * Structurally compatible with pi's TextContent / ImageContent so results
 * pass through toAgentTool() unchanged. */
export type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Result of a tool execution: text/image content (structurally compatible
 * with pi's TextContent/ImageContent) plus structured details for the UI. */
export interface ToolResult {
  content: ToolContentBlock[];
  details: Record<string, unknown>;
}

/** A coding tool, independent of the agent runtime's tool type. Converted
 * to pi's AgentTool by toAgentTool() at the agent boundary. */
export interface Tool<P extends ToolSchema = ToolSchema> {
  name: string;
  label: string;
  description: string;
  parameters: P;
  /** Compatibility shim for raw tool-call arguments before validation. */
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  /** Execute the tool call. Throw on failure instead of encoding errors in
   * `content`. */
  execute: (
    toolCallId: string,
    params: Infer<P>,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
}
