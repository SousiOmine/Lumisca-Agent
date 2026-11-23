/**
 * The scope a check runs in, and the primitives it is written with.
 *
 * One object, one string within a length, one safe key, the state's limits,
 * and the readings of a written value against the initial state. This module
 * knows no expression, component or action, so it is the bottom of
 * `validate/`'s import order.
 */

import type { UiAppProp } from "../catalog.ts";
import { UI_APP_LIMITS } from "../limits.ts";
import { isExpression, resolveStaticValue } from "../resolve.ts";
import { itemValue, pathSegments, valueAtPath } from "../state.ts";
import type { UiAppValue } from "../types.ts";
import { fail, messageOf } from "./errors.ts";

/** What one element's children are drawn with. */
export type Scope = {
  readonly state: Readonly<Record<string, unknown>>;
  /** Whether this element sits inside a Repeat, even one whose array cannot
   * be known before the card runs. */
  readonly repeat: boolean;
  /** The items of the nearest enclosing Repeat, or null when they cannot be
   * known before the card runs. */
  readonly items: readonly unknown[] | null;
  /** The state path of the nearest repeated item, when `over` names one. */
  readonly itemPath: string | null;
  /** Whether `$bindItem` has an address in this scope. */
  readonly bindItem: boolean;
};

/** The value a path names, or a failure. */
export function stateValueOf(path: string, scope: Scope, at: string): unknown {
  try {
    pathSegments(path);
  } catch (error) {
    fail(at, messageOf(error));
  }
  const value = valueAtPath(scope.state, path);
  if (value === undefined) fail(at, `names no state value: ${path}`);
  return value;
}

/** The field of the current repeated item, or a failure when the initial
 * items prove it absent. An unknown repeated array defers the check to the
 * screen. */
export function validateItemField(
  field: string,
  scope: Scope,
  path: string,
): void {
  if (scope.items === null) return;
  if (field === "") return;
  for (const item of scope.items) {
    if (itemValue(item, field) === undefined) {
      fail(path, `the repeated items have no field "${field}"`);
    }
  }
}

/** The field of the current repeated item. */
export function itemValueOf(scope: Scope, field: string): unknown {
  if (scope.items === null) return undefined;
  const first = scope.items[0];
  if (first === undefined) return undefined;
  return itemValue(first, field);
}

/** A value when every expression in it can be resolved before the card runs;
 * undefined when one cannot. Used for checks that compare a prop with the
 * initial state. The resolution rules are `resolveValue`'s: this is the
 * static reading of the same expressions, not a second set of them. */
export function literalValue(value: UiAppValue, scope: Scope): unknown {
  return resolveStaticValue(value, scope);
}

/** The state path a Repeat's `over` names, or null when it is not a state
 * path. */
export function statePathOf(value: unknown): string | null {
  if (!isExpression(value)) return null;
  return typeof value.$state === "string" ? value.$state : null;
}

/** Check a resolved value against the prop's literal kind. */
export function checkType(value: unknown, prop: UiAppProp, path: string): void {
  if (value === undefined) return;
  switch (prop.kind) {
    case "string":
      if (typeof value !== "string") fail(path, "must resolve to a string");
      return;
    case "text":
      if (typeof value !== "string" && typeof value !== "number") {
        fail(path, "must resolve to a string or number");
      }
      return;
    case "number":
      if (typeof value !== "number") fail(path, "must resolve to a number");
      return;
    case "boolean":
      if (typeof value !== "boolean")
        fail(path, "must resolve to true or false");
      return;
    case "enum":
      if (typeof value !== "string" || !prop.values?.includes(value)) {
        fail(path, "must resolve to an allowed string");
      }
      return;
    case "array":
      if (!Array.isArray(value)) fail(path, "must resolve to an array");
      return;
    case "object":
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail(path, "must resolve to an object");
      }
      return;
    case "any":
      return;
  }
}

/** Check one state object and its size. */
export function validateState(state: Readonly<Record<string, unknown>>): void {
  const keys = Object.keys(state);
  if (keys.length > UI_APP_LIMITS.stateKeys) {
    fail(
      "spec.state",
      `${keys.length} keys; the limit is ${UI_APP_LIMITS.stateKeys}`,
    );
  }
  for (const key of keys) {
    keyOf(key, `spec.state.${key}`);
    if (jsonDepth(state[key]) > 8) {
      fail(`spec.state.${key}`, "is nested deeper than 8 levels");
    }
    validateJsonKeys(state[key], `spec.state.${key}`);
  }
  const size = JSON.stringify(state).length;
  if (size > UI_APP_LIMITS.stateChars) {
    fail(
      "spec.state",
      `${size} characters; the limit is ${UI_APP_LIMITS.stateChars}`,
    );
  }
}

/** Every key of a state value, refused when it could reach a prototype. */
export function validateJsonKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      validateJsonKeys(child, `${path}[${index}]`),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keyOf(key, `${path}.${key}`);
      validateJsonKeys(child, `${path}.${key}`);
    }
  }
}

/** The depth of one JSON value. */
export function jsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 1;
  if (Array.isArray(value)) {
    return 1 + Math.max(0, ...value.map((child) => jsonDepth(child)));
  }
  return (
    1 + Math.max(0, ...Object.values(value).map((child) => jsonDepth(child)))
  );
}

/** One object, not an array. */
export function recordOf(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

/** One string within a length. */
export function stringOf(value: unknown, path: string, limit: number): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length > limit) {
    fail(path, `${value.length} characters; the limit is ${limit}`);
  }
  return value;
}

/** Whether a value is a JSON primitive. */
export function isPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** One finite number. */
export function numberOf(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "must be a number");
  }
  return value;
}

/** One array of strings. */
export function stringArrayOf(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array of strings");
  return value.map((item, index) => {
    if (typeof item !== "string") fail(`${path}[${index}]`, "must be a string");
    return item;
  });
}

/** One key that is safe to use as an object key. */
export function keyOf(value: string, path: string): void {
  if (value.length === 0) fail(path, "must not be empty");
  if (value.length > UI_APP_LIMITS.keyChars) {
    fail(
      path,
      `${value.length} characters; the limit is ${UI_APP_LIMITS.keyChars}`,
    );
  }
  if (
    value === "__proto__" ||
    value === "constructor" ||
    value === "prototype"
  ) {
    fail(path, `reserved key "${value}"`);
  }
}
