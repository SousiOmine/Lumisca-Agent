/**
 * Checking one action an element runs.
 *
 * Only three actions exist: `setState` and `resetState` change the card's own
 * state, and `sendMessage` is the one way out of the card. The operation is
 * checked against the value the path holds in the initial state, so "toggle a
 * string" is refused here rather than at the reader's first click.
 */

import type { UiAppComponent } from "../catalog.ts";
import { UI_APP_LIMITS } from "../limits.ts";
import { isExpression } from "../resolve.ts";
import { fail } from "./errors.ts";
import { validateLooseValue } from "./expression.ts";
import {
  isPrimitive,
  recordOf,
  type Scope,
  stateValueOf,
  stringOf,
} from "./values.ts";

/** Check one element's `on` map. */
export function validateOn(
  value: unknown,
  component: UiAppComponent,
  scope: Scope,
  path: string,
): void {
  const on = recordOf(value, path);
  const events = new Set(component.events ?? []);
  if (events.size === 0) {
    fail(path, `<${component.name}> has no events`);
  }
  for (const [event, action] of Object.entries(on)) {
    if (!events.has(event)) {
      fail(`${path}.${event}`, `<${component.name}> has no "${event}" event`);
    }
    if (Array.isArray(action)) {
      if (action.length === 0) {
        fail(`${path}.${event}`, "needs at least one action");
      }
      action.forEach((child, index) =>
        validateAction(child, scope, `${path}.${event}[${index}]`),
      );
    } else {
      validateAction(action, scope, `${path}.${event}`);
    }
  }
}

/** Check one action. */
export function validateAction(
  value: unknown,
  scope: Scope,
  path: string,
): void {
  const action = recordOf(value, path);
  const name = stringOf(action.action, `${path}.action`, 40);
  if (name === "resetState") {
    for (const key of Object.keys(action)) {
      if (key !== "action")
        fail(`${path}.${key}`, "resetState takes no fields");
    }
    return;
  }
  if (name === "sendMessage") {
    for (const key of Object.keys(action)) {
      if (key !== "action" && key !== "text") {
        fail(`${path}.${key}`, "sendMessage takes only text");
      }
    }
    if (!Object.hasOwn(action, "text")) {
      fail(path, "sendMessage needs text");
    }
    validateLooseValue(action.text, scope, `${path}.text`);
    if (typeof action.text === "string" && action.text.length === 0) {
      fail(`${path}.text`, "must not be empty");
    }
    return;
  }
  if (name !== "setState") {
    fail(`${path}.action`, `unknown action "${name}"`);
  }
  const allowed = new Set(["action", "path", "op", "value", "index", "by"]);
  for (const key of Object.keys(action)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unknown setState field");
  }
  const statePath = stringOf(
    action.path,
    `${path}.path`,
    UI_APP_LIMITS.pathChars,
  );
  const current = stateValueOf(statePath, scope, path);
  const op =
    action.op === undefined ? "set" : stringOf(action.op, `${path}.op`, 20);
  if (!["set", "toggle", "increment", "append", "remove"].includes(op)) {
    fail(`${path}.op`, `unknown setState operation "${op}"`);
  }
  if (op === "set") {
    if (!Object.hasOwn(action, "value")) fail(path, "set needs a value");
    if (action.index !== undefined || action.by !== undefined) {
      fail(path, "set takes only a value");
    }
    validateLooseValue(action.value, scope, `${path}.value`);
    if (
      !isExpression(action.value) &&
      isPrimitive(current) &&
      isPrimitive(action.value)
    ) {
      if (typeof current !== typeof action.value) {
        fail(`${path}.value`, "must have the same type as the state value");
      }
    }
    return;
  }
  if (op === "toggle") {
    if (
      action.value !== undefined ||
      action.index !== undefined ||
      action.by !== undefined
    ) {
      fail(path, "toggle takes no value, index or by");
    }
    if (typeof current !== "boolean") {
      fail(`${path}.path`, "toggle needs a boolean state value");
    }
    return;
  }
  if (op === "increment") {
    if (action.value !== undefined || action.index !== undefined) {
      fail(path, "increment takes no value or index");
    }
    if (action.by !== undefined && typeof action.by !== "number") {
      fail(`${path}.by`, "must be a number");
    }
    if (typeof current !== "number") {
      fail(`${path}.path`, "increment needs a number state value");
    }
    return;
  }
  if (op === "append") {
    if (!Object.hasOwn(action, "value")) fail(path, "append needs a value");
    if (action.index !== undefined || action.by !== undefined) {
      fail(path, "append takes only a value");
    }
    if (!Array.isArray(current)) {
      fail(`${path}.path`, "append needs an array state value");
    }
    validateLooseValue(action.value, scope, `${path}.value`);
    return;
  }
  if (op === "remove") {
    if (!Object.hasOwn(action, "index")) fail(path, "remove needs an index");
    if (action.value !== undefined || action.by !== undefined) {
      fail(path, "remove takes only an index");
    }
    if (!Array.isArray(current)) {
      fail(`${path}.path`, "remove needs an array state value");
    }
    if (typeof action.index !== "number" && !isExpression(action.index)) {
      fail(`${path}.index`, "must be a number or an expression");
    }
    validateLooseValue(action.index, scope, `${path}.index`);
  }
}
