import { CoreError } from "../errors.ts";

/**
 * Runtime argument checks that JSON Schema cannot express: ranges and enum
 * membership. The schema layer declares the *type* (the provider still sees
 * `"type": "integer"`), but a value outside the documented range has to be
 * rejected here — and every tool that checks its own arguments goes through
 * this module, so the wording and the error kind (`invalid`, which the
 * server maps to its 400-class status) cannot drift apart.
 *
 * Checks are only added when a tool adopts them; a schema-level `minimum`
 * would be the declarative alternative, and is deliberately not used
 * because a rejected argument must produce the tool's own message.
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
