/**
 * Checking one written expression, literal or condition.
 *
 * The model writes values, not code: an expression names a state path, an
 * item field, the repeat's index, a template or a `$cond`, and each one is
 * read here against the catalog prop it fills and the scope it sits in. A
 * literal is checked by its kind. Comparison and action values have no prop
 * to compare with, so they pass `LOOSE_PROP` and are checked as JSON.
 */

import type { UiAppComponent, UiAppProp } from "../catalog.ts";
import { UI_APP_LIMITS } from "../limits.ts";
import {
  isExpression,
  templateReferences,
  UI_APP_EXPRESSION_KEYS,
} from "../resolve.ts";
import type { UiAppValue } from "../types.ts";
import { fail } from "./errors.ts";
import {
  checkType,
  itemValueOf,
  keyOf,
  numberOf,
  recordOf,
  type Scope,
  stateValueOf,
  stringOf,
  validateItemField,
} from "./values.ts";

/** A prop that accepts any JSON value, used for comparison and action
 * values: those are not component props and have no literal kind. */
export const LOOSE_PROP: UiAppProp = {
  kind: "any",
  expression: true,
  description: "Any JSON value or expression.",
};

/** Check an input's value: it must name the state path it writes. */
export function validateBinding(
  prop: UiAppProp,
  value: unknown,
  scope: Scope,
  path: string,
): void {
  const key = bindingKeyOf(value, path);
  validateBoundKey(key, value as Record<string, unknown>, prop, scope, path);
}

/** The one `$bind*` key a binding carries, or a failure naming what it
 * must be. */
export function bindingKeyOf(
  value: unknown,
  path: string,
): "$bindState" | "$bindItem" {
  if (!isExpression(value)) {
    fail(path, "must be $bindState or $bindItem");
  }
  if (Object.keys(value).length !== 1) {
    fail(path, "a binding carries exactly one key");
  }
  if (Object.hasOwn(value, "$bindState")) return "$bindState";
  if (Object.hasOwn(value, "$bindItem")) return "$bindItem";
  fail(path, "must be $bindState or $bindItem");
}

/**
 * Check one `$bind*` key against the prop it fills and the scope it sits in.
 *
 * The parser reaches a binding from two places: a prop the catalog marks
 * `bind` (`validateBinding`) and an expression written where an expression
 * is allowed (`validateExpression`). Both must read the key the same way,
 * or the same card would be accepted through one door and refused through
 * the other, so the rules live here once.
 */
export function validateBoundKey(
  key: "$bindState" | "$bindItem",
  value: Readonly<Record<string, unknown>>,
  prop: UiAppProp,
  scope: Scope,
  path: string,
): void {
  if (key === "$bindState") {
    if (prop.bind === "item") {
      fail(path, "must be $bindItem here");
    }
    const statePath = stringOf(
      value.$bindState,
      `${path}.$bindState`,
      UI_APP_LIMITS.pathChars,
    );
    const resolved = stateValueOf(statePath, scope, path);
    checkType(resolved, prop, `${path}.$bindState`);
    return;
  }
  if (prop.bind === "state") {
    fail(path, "must be $bindState here");
  }
  if (!scope.bindItem || scope.itemPath === null) {
    fail(path, "$bindItem needs a Repeat over a state path");
  }
  const field = stringOf(
    value.$bindItem,
    `${path}.$bindItem`,
    UI_APP_LIMITS.pathChars,
  );
  if (field.length === 0) fail(`${path}.$bindItem`, "must name a field");
  validateItemField(field, scope, `${path}.$bindItem`);
  const resolved = itemValueOf(scope, field);
  checkType(resolved, prop, `${path}.$bindItem`);
}

/** Check one expression against the prop it fills. */
export function validateExpression(
  value: Readonly<Record<string, unknown>>,
  prop: UiAppProp,
  scope: Scope,
  path: string,
): void {
  const keys = Object.keys(value);
  const expressions = keys.filter((key) =>
    (UI_APP_EXPRESSION_KEYS as readonly string[]).includes(key),
  );
  if (expressions.length !== 1) {
    fail(path, "an expression carries exactly one $ key");
  }
  if (keys.length !== 1) {
    fail(path, "an expression cannot carry other keys");
  }
  const key = expressions[0];
  switch (key) {
    case "$state": {
      const statePath = stringOf(
        value.$state,
        `${path}.$state`,
        UI_APP_LIMITS.pathChars,
      );
      const resolved = stateValueOf(statePath, scope, path);
      checkType(resolved, prop, `${path}.$state`);
      return;
    }
    case "$item": {
      if (!scope.repeat) {
        fail(path, "$item is only inside a Repeat");
      }
      const field = stringOf(
        value.$item,
        `${path}.$item`,
        UI_APP_LIMITS.pathChars,
      );
      validateItemField(field, scope, `${path}.$item`);
      const resolved = itemValueOf(scope, field);
      if (resolved !== undefined) checkType(resolved, prop, `${path}.$item`);
      return;
    }
    case "$index": {
      if (!scope.repeat) {
        fail(path, "$index is only inside a Repeat");
      }
      if (value.$index !== true) fail(`${path}.$index`, "must be true");
      checkType(0, prop, `${path}.$index`);
      return;
    }
    case "$template": {
      const template = stringOf(
        value.$template,
        `${path}.$template`,
        UI_APP_LIMITS.textChars,
      );
      validateTemplate(template, scope, path);
      checkType("", prop, `${path}.$template`);
      return;
    }
    case "$cond": {
      if (!Object.hasOwn(value, "$then") || !Object.hasOwn(value, "$else")) {
        fail(path, "$cond needs $then and $else");
      }
      validateCondition(value.$cond, scope, `${path}.$cond`);
      validateValue(value.$then as UiAppValue, prop, scope, `${path}.$then`);
      validateValue(value.$else as UiAppValue, prop, scope, `${path}.$else`);
      return;
    }
    case "$bindState":
    case "$bindItem": {
      if (prop.bind === undefined) {
        fail(path, `${key} is only an input value`);
      }
      validateBoundKey(key, value, prop, scope, path);
      return;
    }
    default:
      fail(path, `unknown expression "${String(key)}"`);
  }
}

/** Check a literal prop value. */
export function validateLiteral(
  component: UiAppComponent,
  name: string,
  prop: UiAppProp,
  value: unknown,
  scope: Scope,
  path: string,
): void {
  switch (prop.kind) {
    case "string": {
      stringOf(value, path, prop.maxChars);
      return;
    }
    case "text": {
      if (typeof value === "number") return;
      stringOf(value, path, prop.maxChars);
      return;
    }
    case "number": {
      const number = numberOf(value, path);
      if (prop.min !== undefined && number < prop.min) {
        fail(path, `must be at least ${prop.min}`);
      }
      if (prop.max !== undefined && number > prop.max) {
        fail(path, `must be at most ${prop.max}`);
      }
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") fail(path, "must be true or false");
      return;
    }
    case "enum": {
      const text = stringOf(value, path, UI_APP_LIMITS.labelChars);
      if (!prop.values?.includes(text)) {
        fail(path, `must be one of ${prop.values?.join(", ") ?? ""}`);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) fail(path, "must be an array");
      validateArrayItems(value, prop, scope, path, component.name, name);
      return;
    }
    case "object": {
      validateLooseValue(value, scope, path);
      return;
    }
    case "any": {
      validateLooseValue(value, scope, path);
      return;
    }
  }
}

/** Check one value with no component prop to compare it to. */
export function validateValue(
  value: UiAppValue,
  prop: UiAppProp,
  scope: Scope,
  path: string,
): void {
  if (isExpression(value)) {
    if (prop.expression !== true) {
      fail(path, "does not accept an expression");
    }
    validateExpression(value, prop, scope, path);
    return;
  }
  validateLiteral(
    { name: "", description: "", props: {} },
    "",
    prop,
    value,
    scope,
    path,
  );
}

/** Check an array prop's items by the shape the catalog names. */
export function validateArrayItems(
  value: readonly unknown[],
  prop: UiAppProp,
  scope: Scope,
  path: string,
  componentName: string,
  propName: string,
): void {
  const itemKind = prop.items ?? "any";
  const itemLimit =
    componentName === "Table" && propName === "columns"
      ? UI_APP_LIMITS.tableCellChars
      : UI_APP_LIMITS.listItemChars;
  if (itemKind === "option" && value.length > UI_APP_LIMITS.selectOptions) {
    fail(
      path,
      `${value.length} options; the limit is ${UI_APP_LIMITS.selectOptions}`,
    );
  }
  if (itemKind === "row" && value.length > UI_APP_LIMITS.tableRows) {
    fail(path, `${value.length} rows; the limit is ${UI_APP_LIMITS.tableRows}`);
  }
  if (itemKind === "flow-node" && value.length > UI_APP_LIMITS.flowNodes) {
    fail(
      path,
      `${value.length} nodes; the limit is ${UI_APP_LIMITS.flowNodes}`,
    );
  }
  if (itemKind === "flow-edge" && value.length > UI_APP_LIMITS.flowEdges) {
    fail(
      path,
      `${value.length} edges; the limit is ${UI_APP_LIMITS.flowEdges}`,
    );
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    switch (itemKind) {
      case "string": {
        stringOf(item, itemPath, itemLimit);
        return;
      }
      case "option": {
        const option = recordOf(item, itemPath);
        stringOf(option.label, `${itemPath}.label`, UI_APP_LIMITS.labelChars);
        if (typeof option.value !== "string") {
          fail(`${itemPath}.value`, "must be a string");
        }
        return;
      }
      case "row": {
        if (!Array.isArray(item)) fail(itemPath, "must be an array of cells");
        if (item.length > UI_APP_LIMITS.tableColumns) {
          fail(
            itemPath,
            `${item.length} cells; the limit is ${UI_APP_LIMITS.tableColumns}`,
          );
        }
        item.forEach((cell, cellIndex) => {
          stringOf(
            cell,
            `${itemPath}[${cellIndex}]`,
            UI_APP_LIMITS.tableCellChars,
          );
        });
        return;
      }
      case "flow-node": {
        const node = recordOf(item, itemPath);
        const id = stringOf(
          node.id,
          `${itemPath}.id`,
          UI_APP_LIMITS.flowNodeIdChars,
        );
        if (!/^[A-Za-z0-9_-]+$/.test(id)) {
          fail(`${itemPath}.id`, "must use letters, digits, _ or -");
        }
        stringOf(node.label, `${itemPath}.label`, UI_APP_LIMITS.flowLabelChars);
        const shape = stringOf(node.shape, `${itemPath}.shape`, 20);
        if (!["box", "round", "diamond", "pill"].includes(shape)) {
          fail(`${itemPath}.shape`, "must be box, round, diamond or pill");
        }
        return;
      }
      case "flow-edge": {
        const edge = recordOf(item, itemPath);
        stringOf(edge.from, `${itemPath}.from`, UI_APP_LIMITS.flowNodeIdChars);
        stringOf(edge.to, `${itemPath}.to`, UI_APP_LIMITS.flowNodeIdChars);
        if (edge.label !== undefined) {
          stringOf(
            edge.label,
            `${itemPath}.label`,
            UI_APP_LIMITS.flowLabelChars,
          );
        }
        if (edge.dashed !== undefined && typeof edge.dashed !== "boolean") {
          fail(`${itemPath}.dashed`, "must be true or false");
        }
        return;
      }
      case "any": {
        validateLooseValue(item, scope, itemPath);
        return;
      }
    }
  });
}

/** Check a value that is not tied to a component prop: a comparison, an
 * action value, or a nested JSON value. */
export function validateLooseValue(
  value: unknown,
  scope: Scope,
  path: string,
): void {
  if (isExpression(value)) {
    validateExpression(value, LOOSE_PROP, scope, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateLooseValue(item, scope, `${path}[${index}]`),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keyOf(key, `${path}.${key}`);
      validateLooseValue(child, scope, `${path}.${key}`);
    }
    return;
  }
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean" &&
    value !== null
  ) {
    fail(path, "must be JSON");
  }
}

/** Check one condition. */
export function validateCondition(
  value: unknown,
  scope: Scope,
  path: string,
): void {
  if (typeof value === "boolean") return;
  const condition = recordOf(value, path);
  const allowed = new Set([
    "$state",
    "$item",
    "$index",
    "$and",
    "$or",
    "not",
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
  ]);
  for (const key of Object.keys(condition)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unknown condition key");
  }
  const subjects = ["$state", "$item", "$index", "$and", "$or"].filter((key) =>
    Object.hasOwn(condition, key),
  );
  if (subjects.length !== 1) {
    fail(path, "a condition names exactly one subject");
  }
  if (condition.not !== undefined && condition.not !== true) {
    fail(`${path}.not`, "must be true");
  }
  const comparisons = ["eq", "neq", "gt", "gte", "lt", "lte"].filter((key) =>
    Object.hasOwn(condition, key),
  );
  if (comparisons.length > 1) {
    fail(path, "a condition compares with one operator");
  }
  const subject = subjects[0];
  if (subject === "$and" || subject === "$or") {
    if (comparisons.length > 0) {
      fail(path, `$${subject.slice(1)} cannot carry a comparison`);
    }
    if (!Array.isArray(condition[subject])) {
      fail(`${path}.${subject}`, "must be an array of conditions");
    }
    if (condition[subject].length === 0) {
      fail(`${path}.${subject}`, "needs at least one condition");
    }
    condition[subject].forEach((child, index) =>
      validateCondition(child, scope, `${path}.${subject}[${index}]`),
    );
    return;
  }
  if (subject === "$state") {
    const statePath = stringOf(
      condition.$state,
      `${path}.$state`,
      UI_APP_LIMITS.pathChars,
    );
    stateValueOf(statePath, scope, path);
  } else if (subject === "$item") {
    if (!scope.repeat) {
      fail(path, "$item is only inside a Repeat");
    }
    const field = stringOf(
      condition.$item,
      `${path}.$item`,
      UI_APP_LIMITS.pathChars,
    );
    validateItemField(field, scope, `${path}.$item`);
  } else if (subject === "$index") {
    if (!scope.repeat) {
      fail(path, "$index is only inside a Repeat");
    }
    if (condition.$index !== true) fail(`${path}.$index`, "must be true");
  }
  if (Object.hasOwn(condition, "eq")) {
    validateLooseValue(condition.eq, scope, `${path}.eq`);
  }
  if (Object.hasOwn(condition, "neq")) {
    validateLooseValue(condition.neq, scope, `${path}.neq`);
  }
  for (const key of ["gt", "gte", "lt", "lte"] as const) {
    if (Object.hasOwn(condition, key) && typeof condition[key] !== "number") {
      fail(`${path}.${key}`, "must be a number");
    }
  }
}

/** Check one template's references against the state and the repeat. */
export function validateTemplate(
  template: string,
  scope: Scope,
  path: string,
): void {
  for (const reference of templateReferences(template)) {
    if (reference.startsWith("/")) {
      stateValueOf(reference, scope, `${path}.$template`);
      continue;
    }
    if (reference.startsWith("item.")) {
      if (!scope.repeat) {
        fail(`${path}.$template`, "$item is only inside a Repeat");
      }
      validateItemField(reference.slice(5), scope, `${path}.$template`);
      continue;
    }
    if (reference === "index") {
      if (!scope.repeat) {
        fail(`${path}.$template`, "$index is only inside a Repeat");
      }
      continue;
    }
    fail(`${path}.$template`, `unknown template reference "${reference}"`);
  }
}
