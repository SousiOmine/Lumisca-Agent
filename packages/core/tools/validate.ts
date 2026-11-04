import { CoreError } from "../errors.ts";
import type { SchemaObject, ToolSchema } from "./schema.ts";

/**
 * Runtime argument checks that a provider may ignore: bounds and enum
 * membership. A JSON Schema `minimum` is advisory — a model can (and does)
 * send `max_results: -5` — so the tool must reject it, and the wording and
 * the error kind (`invalid`, which the server maps to its 400-class status)
 * stay in this module so they cannot drift between tools.
 *
 * Two layers:
 * - {@link assertSchemaBounds} enforces what the schema already declares
 *   (`integer(desc, { min, max })`), called once for every tool call at the
 *   adapter boundary (tools/pi-adapter.ts, tools/registry.ts). A tool that
 *   only needs ranges therefore writes no validation code at all.
 * - The `require*` helpers remain for checks with no schema form (an enum
 *   of strings, a cross-field rule); a tool calls them in its `execute`.
 */

/** Require an integer; returns it so the check can wrap the value inline. */
export function requireInteger(name: string, value: number): number {
  if (!Number.isInteger(value)) {
    throw new CoreError(`${name} must be an integer (got ${value})`, "invalid");
  }
  return value;
}

/** Require an integer within `min..max` (both inclusive). */
export function requireIntegerInRange(
  name: string,
  value: number,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CoreError(
      `${name} must be an integer between ${min} and ${max} (got ${value})`,
      "invalid",
    );
  }
  return value;
}

/** Require a value from `allowed`; returns it narrowed to the union. */
export function requireOneOf<T extends string>(
  name: string,
  value: string,
  allowed: readonly T[],
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CoreError(
      `${name} must be one of ${allowed.join(", ")} (got ${value})`,
      "invalid",
    );
  }
  return value as T;
}

/**
 * Enforce what a tool's schema declares about its arguments. Called at the
 * adapter boundary, so every call — preloaded tools, discoverable tools, the
 * sub-agent's tools — is checked the same way, and a tool's `execute` never
 * sees a value the schema forbids.
 *
 * Two checks, both here for the same reason (the schema is what the provider
 * was TOLD, not what it sends):
 *
 * - Required arguments must be present. JSON Schema `required` is advisory
 *   at the wire, and a model omits a key it considers obvious — the `cwd` of
 *   `bash` went missing in roughly one call in twenty, and every one of them
 *   failed deep inside path resolution with "Path must be a non-empty
 *   string", which names neither the argument nor the tool. Reporting the
 *   omission here costs nothing and says which argument to add.
 * - Declared integer bounds must hold. A model can (and does) send
 *   `max_results: -5`.
 *
 * Only top-level values are examined, which is where every declaration in
 * this codebase lives (a nested one would need the same walk, so extend this
 * when one appears). Values of another type are left to the tool: a type
 * mismatch is the tool's own contract to report, and its error says more
 * about what the value is used for.
 */
export function assertSchemaBounds(
  parameters: ToolSchema,
  params: unknown,
): void {
  if (parameters.type !== "object" || params === null) return;
  if (typeof params !== "object" || Array.isArray(params)) return;
  const properties = (parameters as SchemaObject).properties;
  const sent = params as Record<string, unknown>;
  for (const name of (parameters as SchemaObject).required) {
    // `null` counts as missing: it is what a model sends for a field it chose
    // not to fill, and it reaches the tool as a value no argument parser
    // accepts (path resolution sees a non-string and says "Path must be a
    // non-empty string"). A required argument is either answered or absent.
    if (sent[name] !== undefined && sent[name] !== null) continue;
    throw new CoreError(
      `Missing required argument: ${name}. Send it and call again.`,
      "invalid",
    );
  }
  for (const [name, schema] of Object.entries(properties)) {
    if (schema.type !== "integer") continue;
    const value = (params as Record<string, unknown>)[name];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value)) continue;
    const { minimum, maximum } = schema;
    if (minimum === undefined && maximum === undefined) continue;
    if (
      (minimum !== undefined && value < minimum) ||
      (maximum !== undefined && value > maximum)
    ) {
      throw new CoreError(
        `${name} must be an integer between ${minimum ?? "…"} and ${
          maximum ?? "…"
        } (got ${value})`,
        "invalid",
      );
    }
  }
}

/** Require a value the schema declares as a string to actually be one.
 *
 * The schema is what the provider was TOLD, not what it sends: a model
 * routinely emits `"id": 1` for a field documented as a string, and JSON
 * Schema `type` is advisory at the wire. Without this check the value travels
 * through the transcript and comes back to the server on the next request —
 * where a boundary that does check types (the answer route's) rejects it, or
 * a map keyed by the value silently misses. A `null` is not an absent
 * optional field either: it was sent, so it is wrong.
 *
 * `where` names the value in the error ("questions[0].id"), so the model can
 * fix the call instead of guessing.
 */
export function requireStringValue(value: unknown, where: string): string {
  if (typeof value !== "string") {
    const shown = value === null ? "null" : typeof value;
    throw new CoreError(`${where} must be a string (got ${shown})`, "invalid");
  }
  return value;
}
