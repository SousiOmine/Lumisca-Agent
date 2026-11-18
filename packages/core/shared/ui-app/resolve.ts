/**
 * Reading an app card's expressions and running its actions.
 *
 * The parser has already checked every path and scope; this module is the
 * one place that turns a written value into the value the screen draws, and
 * a written action into a state change or a message. It does not parse and
 * it does not decide whether a spec is acceptable: a path that is absent
 * here is a bug in the parser or in a caller, not a card to draw blank.
 */
import { itemValue, type UiAppStateStore, valueAtPath } from "./state.ts";
import type {
  UiAppAction,
  UiAppBinding,
  UiAppCondition,
  UiAppContext,
  UiAppResolvedProps,
  UiAppResolvedValue,
  UiAppValue,
} from "./types.ts";

/** The expression keys an object may carry. */
export const UI_APP_EXPRESSION_KEYS = [
  "$state",
  "$item",
  "$index",
  "$template",
  "$cond",
  "$bindState",
  "$bindItem",
] as const;

/** Whether an object is one expression rather than a plain object. */
export function isExpression(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return UI_APP_EXPRESSION_KEYS.some((key) => Object.hasOwn(value, key));
}

/** The state path a bound prop writes, or null when the value is not a
 * binding. A `$bindItem` outside a repeat that has an address is refused by
 * the parser; reaching here without one is a mistake. */
export function bindingOf(
  value: UiAppValue,
  ctx: UiAppContext,
): UiAppBinding | null {
  if (!isExpression(value)) return null;
  const expression = value as Record<string, unknown>;
  if (typeof expression.$bindState === "string") {
    return { path: expression.$bindState };
  }
  if (typeof expression.$bindItem === "string") {
    if (!ctx.bindItem || ctx.itemPath === null) {
      throw new Error("$bindItem outside a repeat with a state path");
    }
    const field = expression.$bindItem.split(".").join("/");
    return { path: `${ctx.itemPath}/${field}` };
  }
  return null;
}

/** One written value with every expression resolved. */
export function resolveValue(
  value: UiAppValue,
  ctx: UiAppContext,
): UiAppResolvedValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((child) => resolveValue(child as UiAppValue, ctx));
  }
  if (isExpression(value)) {
    const expression = value as Record<string, unknown>;
    if (typeof expression.$state === "string") {
      return asResolved(valueAtPath(ctx.state, expression.$state));
    }
    if (typeof expression.$item === "string") {
      return asResolved(itemValue(ctx.item, expression.$item));
    }
    if (expression.$index === true) return ctx.index;
    if (typeof expression.$template === "string") {
      return renderTemplate(expression.$template, ctx);
    }
    if (isCondition(expression.$cond)) {
      return resolveValue(
        resolveCondition(expression.$cond, ctx)
          ? (expression.$then as UiAppValue)
          : (expression.$else as UiAppValue),
        ctx,
      );
    }
    if (typeof expression.$bindState === "string") {
      return asResolved(valueAtPath(ctx.state, expression.$bindState));
    }
    if (typeof expression.$bindItem === "string") {
      return asResolved(itemValue(ctx.item, expression.$bindItem));
    }
  }
  const resolved: Record<string, UiAppResolvedValue> = {};
  for (const [key, child] of Object.entries(value)) {
    resolved[key] = resolveValue(child as UiAppValue, ctx);
  }
  return resolved;
}

/** One element's props, plus the state paths its inputs write. */
export function resolveProps(
  props: Readonly<Record<string, UiAppValue>> | undefined,
  ctx: UiAppContext,
): UiAppResolvedProps {
  const resolved: Record<string, UiAppResolvedValue> = {};
  const bindings: Record<string, UiAppBinding> = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    const binding = bindingOf(value, ctx);
    if (binding !== null) bindings[key] = binding;
    resolved[key] = resolveValue(value, ctx);
  }
  return { props: resolved, bindings };
}

/** Whether a condition holds in this draw. */
export function resolveCondition(
  condition: UiAppCondition,
  ctx: UiAppContext,
): boolean {
  if (typeof condition === "boolean") return condition;
  const record = condition as Record<string, unknown>;
  if (Array.isArray(record.$and)) {
    const group = record.$and.every((child) =>
      resolveCondition(child as UiAppCondition, ctx),
    );
    return record.not === true ? !group : group;
  }
  if (Array.isArray(record.$or)) {
    const group = record.$or.some((child) =>
      resolveCondition(child as UiAppCondition, ctx),
    );
    return record.not === true ? !group : group;
  }
  let subject: unknown;
  if (typeof record.$state === "string") {
    subject = valueAtPath(ctx.state, record.$state);
  } else if (typeof record.$item === "string") {
    subject = itemValue(ctx.item, record.$item);
  } else if (record.$index === true) {
    subject = ctx.index;
  } else {
    throw new Error("Condition names no subject");
  }
  let result: boolean;
  if (Object.hasOwn(record, "eq")) {
    result = jsonEqual(subject, resolveValue(record.eq as UiAppValue, ctx));
  } else if (Object.hasOwn(record, "neq")) {
    result = !jsonEqual(subject, resolveValue(record.neq as UiAppValue, ctx));
  } else if (typeof record.gt === "number") {
    result = typeof subject === "number" && subject > record.gt;
  } else if (typeof record.gte === "number") {
    result = typeof subject === "number" && subject >= record.gte;
  } else if (typeof record.lt === "number") {
    result = typeof subject === "number" && subject < record.lt;
  } else if (typeof record.lte === "number") {
    result = typeof subject === "number" && subject <= record.lte;
  } else {
    result = Boolean(subject);
  }
  return record.not === true ? !result : result;
}

/** The references one template names, in order. The parser checks them;
 * the renderer resolves the same syntax. */
export function templateReferences(template: string): string[] {
  const references: string[] = [];
  const protectedText = template.replace(/\$\$\{/g, "\u0000{");
  for (const match of protectedText.matchAll(/\$\{([^}]*)\}/g)) {
    references.push(match[1] ?? "");
  }
  return references;
}

/** One action, applied to the store. `send` is the conversation's next
 * message; without it, `sendMessage` has nowhere to go. */
export function applyAction(
  action: UiAppAction,
  ctx: UiAppContext,
  store: UiAppStateStore,
  send?: (text: string) => void,
): void {
  switch (action.action) {
    case "setState": {
      const op = action.op ?? "set";
      switch (op) {
        case "set": {
          if (action.value === undefined) {
            throw new Error("setState set needs a value");
          }
          store.set(action.path, resolveValue(action.value, ctx));
          return;
        }
        case "toggle": {
          store.update(action.path, (current) => {
            if (typeof current !== "boolean") {
              throw new Error(
                `setState toggle needs a boolean: ${action.path}`,
              );
            }
            return !current;
          });
          return;
        }
        case "increment": {
          const by = action.by ?? 1;
          store.update(action.path, (current) => {
            if (typeof current !== "number") {
              throw new Error(
                `setState increment needs a number: ${action.path}`,
              );
            }
            return current + by;
          });
          return;
        }
        case "append": {
          if (action.value === undefined) {
            throw new Error("setState append needs a value");
          }
          const value = resolveValue(action.value, ctx);
          store.update(action.path, (current) => {
            if (!Array.isArray(current)) {
              throw new Error(`setState append needs an array: ${action.path}`);
            }
            return [...current, value];
          });
          return;
        }
        case "remove": {
          if (action.index === undefined) {
            throw new Error("setState remove needs an index");
          }
          const index = resolveValue(action.index, ctx);
          if (typeof index !== "number" || !Number.isInteger(index)) {
            throw new Error("setState remove index must be an integer");
          }
          store.update(action.path, (current) => {
            if (!Array.isArray(current)) {
              throw new Error(`setState remove needs an array: ${action.path}`);
            }
            if (index < 0 || index >= current.length) {
              throw new Error(
                `setState remove index is out of range: ${index}`,
              );
            }
            return current.filter((_, position) => position !== index);
          });
          return;
        }
      }
      return;
    }
    case "resetState": {
      store.reset();
      return;
    }
    case "sendMessage": {
      if (send === undefined) return;
      const text = textOf(resolveValue(action.text, ctx));
      if (text.length > 0) send(text);
      return;
    }
  }
}

/** A list of actions in order. Each one sees the state the previous one
 * left, so "append and clear the draft" behaves as written. */
export function applyActions(
  actions: readonly UiAppAction[],
  ctx: UiAppContext,
  store: UiAppStateStore,
  send?: (text: string) => void,
): void {
  for (const action of actions) {
    applyAction(action, { ...ctx, state: store.snapshot() }, store, send);
  }
}

/** A resolved value as the text a template or a message shows. */
export function textOf(value: UiAppResolvedValue | unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Deep equality for JSON values, used by `eq` and `neq`. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => jsonEqual(value, b[index]));
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const left = Object.keys(a);
    const right = Object.keys(b);
    if (left.length !== right.length) return false;
    return left.every(
      (key) =>
        Object.hasOwn(b, key) &&
        jsonEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
    );
  }
  return false;
}

/** A value read from state as a resolved value. The state is JSON, so an
 * object or array needs no conversion; `undefined` becomes null because a
 * missing path is drawn as an empty value. */
function asResolved(value: unknown): UiAppResolvedValue {
  return (value === undefined ? null : value) as UiAppResolvedValue;
}

/** One template, with state, item and index references replaced. A `$${`
 * writes a literal `${`; the parser sees the same escape. */
function renderTemplate(template: string, ctx: UiAppContext): string {
  const protectedText = template.replace(/\$\$\{/g, "\u0000{");
  const rendered = protectedText.replace(
    /\$\{([^}]*)\}/g,
    (_match, token: string) => {
      if (token.startsWith("/")) {
        return textOf(valueAtPath(ctx.state, token));
      }
      if (token.startsWith("item.")) {
        return textOf(itemValue(ctx.item, token.slice(5)));
      }
      if (token === "index") return String(ctx.index);
      return "";
    },
  );
  return rendered.replace(/\u0000\{/g, "${");
}

/** Whether a value is a condition object. The parser owns the full check;
 * this narrows a `$cond` branch before reading it. */
function isCondition(value: unknown): value is UiAppCondition {
  return (
    typeof value === "boolean" || (value !== null && typeof value === "object")
  );
}
