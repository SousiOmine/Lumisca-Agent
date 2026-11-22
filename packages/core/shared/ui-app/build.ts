/**
 * Parsing and checking one app card's JSON.
 *
 * The model writes the spec, so every fact the screen relies on is checked
 * here before a component sees it: the element graph, the catalog's props,
 * every state path, every expression's scope, every action, and the limits
 * that keep a card a card. A failure is a message for the model and the
 * reader, not a half-drawn card.
 */
import {
  UI_APP_COMPONENT_BY_NAME,
  UI_APP_COMPONENTS,
  UI_APP_ROOT_TYPE,
  type UiAppComponent,
  type UiAppProp,
} from "./catalog.ts";
import { UI_APP_LIMITS } from "./limits.ts";
import {
  isExpression,
  templateReferences,
  UI_APP_EXPRESSION_KEYS,
} from "./resolve.ts";
import { itemValue, pathSegments, valueAtPath } from "./state.ts";
import type { UiAppParseResult, UiAppSpec, UiAppValue } from "./types.ts";

/** A spec mistake, with the place that names it. */
class AppSpecError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "AppSpecError";
  }
}

function fail(path: string, message: string): never {
  throw new AppSpecError(path, message);
}

/** What one element's children are drawn with. */
type Scope = {
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

/** A prop that accepts any JSON value, used for comparison and action
 * values: those are not component props and have no literal kind. */
const LOOSE_PROP: UiAppProp = {
  kind: "any",
  expression: true,
  description: "Any JSON value or expression.",
};

/** Parse one finished spec. */
export function parseAppSpec(source: string): UiAppParseResult {
  if (source.length > UI_APP_LIMITS.chars) {
    return {
      ok: false,
      problem: `spec: ${source.length} characters; the limit is ${UI_APP_LIMITS.chars}`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    return { ok: false, problem: `spec: invalid JSON: ${messageOf(error)}` };
  }
  try {
    return { ok: true, spec: validateSpec(raw) };
  } catch (error) {
    if (error instanceof AppSpecError) {
      return { ok: false, problem: error.message };
    }
    throw error;
  }
}

/**
 * Parse a spec that is still being written.
 *
 * The unfinished tail is completed first: an open string is closed, an open
 * object or array is closed, and a trailing comma or colon is removed. The
 * result is still parsed by {@link parseAppSpec}, so a partial spec that
 * names a missing element or an unknown prop is refused like a finished
 * one. The caller draws a skeleton when this refuses.
 */
export function parseAppSpecPartial(source: string): UiAppParseResult {
  if (source.length > UI_APP_LIMITS.chars) return parseAppSpec(source);
  return parseAppSpec(completeJson(source));
}

/**
 * Close what a streaming JSON document has not closed yet.
 *
 * This is a repair for display, not a parser: it only makes the prefix
 * syntactically closer to a document. A prefix that ends inside a literal
 * (`tru`) or a number (`1.`) stays invalid, and the caller draws a skeleton
 * until the next fragment arrives.
 */
export function completeJson(source: string): string {
  let inString = false;
  let escaped = false;
  const stack: Array<"{" | "["> = [];
  for (const char of source) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      stack.push("{");
      continue;
    }
    if (char === "[") {
      stack.push("[");
      continue;
    }
    if (char === "}" || char === "]") {
      stack.pop();
    }
  }
  let text = source;
  if (inString) {
    if (escaped) text += "\\";
    text += '"';
  }
  text = text.replace(/[\s,]+$/u, "");
  if (text.endsWith(":")) text += " null";
  for (let index = stack.length - 1; index >= 0; index--) {
    text += stack[index] === "{" ? "}" : "]";
  }
  return text;
}

/** Check one parsed value and return it as a spec. */
function validateSpec(raw: unknown): UiAppSpec {
  const spec = recordOf(raw, "spec");
  if (spec.version !== 1) {
    fail("spec.version", "must be 1");
  }
  if (spec.title !== undefined) {
    stringOf(spec.title, "spec.title", UI_APP_LIMITS.titleChars);
  }
  if (spec.description !== undefined) {
    stringOf(
      spec.description,
      "spec.description",
      UI_APP_LIMITS.descriptionChars,
    );
  }
  const state = recordOf(spec.state, "spec.state");
  validateState(state);
  const root = stringOf(spec.root, "spec.root", UI_APP_LIMITS.keyChars);
  const elements = recordOf(spec.elements, "spec.elements");
  const count = Object.keys(elements).length;
  if (count === 0) fail("spec.elements", "must hold at least one element");
  if (count > UI_APP_LIMITS.elements) {
    fail(
      "spec.elements",
      `${count} elements; the limit is ${UI_APP_LIMITS.elements}`,
    );
  }
  for (const [id, value] of Object.entries(elements)) {
    keyOf(id, `spec.elements.${id}`);
    recordOf(value, `spec.elements.${id}`);
  }
  if (!Object.hasOwn(elements, root)) {
    fail("spec.root", `names no element: ${root}`);
  }
  const rootElement = recordOf(elements[root], `spec.elements.${root}`);
  if (rootElement.type !== UI_APP_ROOT_TYPE) {
    fail(
      `spec.elements.${root}.type`,
      `the root must be <${UI_APP_ROOT_TYPE}>, not <${String(rootElement.type)}>`,
    );
  }
  const scope: Scope = {
    state,
    repeat: false,
    items: null,
    itemPath: null,
    bindItem: false,
  };
  const visited = new Set<string>();
  const stack = new Set<string>();
  visitElement(root, null, scope, 1, elements, visited, stack, root);
  for (const id of Object.keys(elements)) {
    if (!visited.has(id)) {
      fail(`spec.elements.${id}`, "is not reachable from the root");
    }
  }
  const expanded = expandedCount(root, elements, scope);
  if (expanded > UI_APP_LIMITS.expandedElements) {
    fail(
      "spec.elements",
      `${expanded} elements after repeats; the limit is ${UI_APP_LIMITS.expandedElements}`,
    );
  }
  return spec as unknown as UiAppSpec;
}

/** How many elements one draw produces after repeats expand. An array that
 * cannot be known before the card runs counts as one item: the runtime caps
 * the real expansion, and this check exists for the case the model CAN know
 * it wrote too much. */
function expandedCount(
  id: string,
  elements: Readonly<Record<string, unknown>>,
  scope: Scope,
): number {
  const element = recordOf(elements[id], `spec.elements.${id}`);
  const children = Array.isArray(element.children)
    ? element.children.filter(
        (child): child is string => typeof child === "string",
      )
    : [];
  if (element.type !== "Repeat") {
    let count = 1;
    for (const child of children) {
      count += expandedCount(child, elements, scope);
    }
    return count;
  }
  const props =
    element.props === undefined
      ? {}
      : recordOf(element.props, `spec.elements.${id}.props`);
  const over = props.over as UiAppValue | undefined;
  const value = over === undefined ? undefined : literalValue(over, scope);
  const items = Array.isArray(value) ? value : [null];
  const itemPath = statePathOf(over);
  const childScope: Scope = {
    ...scope,
    repeat: true,
    items: Array.isArray(value) ? value : null,
    itemPath,
    bindItem: itemPath !== null,
  };
  let count = 1;
  for (let index = 0; index < items.length; index++) {
    for (const child of children) {
      count += expandedCount(child, elements, childScope);
    }
  }
  return count;
}

/** Walk one element and its children, checking the context each child is
 * drawn in. */
function visitElement(
  id: string,
  parentType: string | null,
  scope: Scope,
  depth: number,
  elements: Readonly<Record<string, unknown>>,
  visited: Set<string>,
  stack: Set<string>,
  root: string,
): void {
  if (stack.has(id)) {
    fail(`spec.elements.${id}`, "is part of a cycle");
  }
  if (visited.has(id)) {
    fail(`spec.elements.${id}`, "is reached from two parents");
  }
  if (depth > UI_APP_LIMITS.depth) {
    fail(`spec.elements.${id}`, `is deeper than ${UI_APP_LIMITS.depth} levels`);
  }
  visited.add(id);
  stack.add(id);
  const path = `spec.elements.${id}`;
  const element = recordOf(elements[id], path);
  const type = stringOf(element.type, `${path}.type`, UI_APP_LIMITS.keyChars);
  const component = UI_APP_COMPONENT_BY_NAME.get(type);
  if (component === undefined) {
    fail(`${path}.type`, `unknown component "${type}"`);
  }
  if (type === UI_APP_ROOT_TYPE && id !== root) {
    fail(`${path}.type`, `<${UI_APP_ROOT_TYPE}> is only the root`);
  }
  if (type === "Tab" && parentType !== "Tabs") {
    fail(`${path}.type`, "<Tab> is only inside <Tabs>");
  }
  const props =
    element.props === undefined ? {} : recordOf(element.props, `${path}.props`);
  const children =
    element.children === undefined
      ? []
      : stringArrayOf(element.children, `${path}.children`);
  if (component.children === undefined) {
    if (children.length > 0) {
      fail(`${path}.children`, `<${type}> has no children`);
    }
  } else {
    if (children.length === 0) {
      fail(`${path}.children`, `<${type}> needs at least one child`);
    }
    if (children.length > component.children.max) {
      fail(
        `${path}.children`,
        `${children.length} children; the limit is ${component.children.max}`,
      );
    }
    if (new Set(children).size !== children.length) {
      fail(`${path}.children`, "names a child twice");
    }
    for (const child of children) {
      if (!Object.hasOwn(elements, child)) {
        fail(`${path}.children`, `names no element: ${child}`);
      }
    }
  }
  if (type === "Tabs" && children.length > UI_APP_LIMITS.tabs) {
    fail(
      `${path}.children`,
      `${children.length} tabs; the limit is ${UI_APP_LIMITS.tabs}`,
    );
  }
  if (type === "Tabs") {
    for (const child of children) {
      const childElement = recordOf(elements[child], `spec.elements.${child}`);
      if (childElement.type !== "Tab") {
        fail(`${path}.children`, `<Tabs> children must be <Tab>`);
      }
    }
  }
  if (element.visible !== undefined) {
    if (id === root) fail(`${path}.visible`, "the root cannot be hidden");
    validateCondition(element.visible, scope, `${path}.visible`);
  }
  if (element.on !== undefined) {
    validateOn(element.on, component, scope, `${path}.on`);
  }
  const childScope = validateProps(props, component, scope, path);
  for (const child of children) {
    visitElement(
      child,
      type,
      childScope,
      depth + 1,
      elements,
      visited,
      stack,
      root,
    );
  }
  postCheck(type, props, children, elements, scope, path);
  stack.delete(id);
}

/** Check every written prop and return the scope the children are drawn
 * with. Only `<Repeat>` changes it. */
function validateProps(
  props: Readonly<Record<string, unknown>>,
  component: UiAppComponent,
  scope: Scope,
  path: string,
): Scope {
  for (const [name, prop] of Object.entries(component.props)) {
    if (prop.required === true && !Object.hasOwn(props, name)) {
      fail(`${path}.props`, `<${component.name}> needs "${name}"`);
    }
  }
  for (const [name, value] of Object.entries(props)) {
    const prop = component.props[name];
    if (prop === undefined) {
      fail(
        `${path}.props.${name}`,
        `<${component.name}> has no prop "${name}"`,
      );
    }
    validateProp(component, name, prop, value, scope, `${path}.props.${name}`);
  }
  if (component.name !== "Repeat") return scope;
  const over = props.over;
  if (over === undefined) return scope;
  const value = literalValue(over as UiAppValue, scope);
  if (!Array.isArray(value)) {
    return {
      ...scope,
      repeat: true,
      items: null,
      itemPath: null,
      bindItem: false,
    };
  }
  const itemPath = statePathOf(over);
  return {
    ...scope,
    repeat: true,
    items: value,
    itemPath,
    bindItem: itemPath !== null,
  };
}

/** Check one prop against its definition. */
function validateProp(
  component: UiAppComponent,
  name: string,
  prop: UiAppProp,
  value: unknown,
  scope: Scope,
  path: string,
): void {
  if (prop.bind !== undefined) {
    validateBinding(prop, value, scope, path);
    return;
  }
  if (isExpression(value)) {
    if (prop.expression !== true) {
      fail(path, `"${name}" does not accept an expression`);
    }
    validateExpression(value, prop, scope, path);
    return;
  }
  validateLiteral(component, name, prop, value, scope, path);
}

/** Check an input's value: it must name the state path it writes. */
function validateBinding(
  prop: UiAppProp,
  value: unknown,
  scope: Scope,
  path: string,
): void {
  if (!isExpression(value)) {
    fail(path, "must be $bindState or $bindItem");
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    fail(path, "a binding carries exactly one key");
  }
  if (Object.hasOwn(value, "$bindState")) {
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
  if (Object.hasOwn(value, "$bindItem")) {
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
    return;
  }
  fail(path, "must be $bindState or $bindItem");
}

/** Check one expression against the prop it fills. */
function validateExpression(
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
    case "$bindState": {
      if (prop.bind === undefined) {
        fail(path, "$bindState is only an input value");
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
    case "$bindItem": {
      if (prop.bind === undefined) {
        fail(path, "$bindItem is only an input value");
      }
      if (!scope.bindItem || scope.itemPath === null) {
        fail(path, "$bindItem needs a Repeat over a state path");
      }
      const field = stringOf(
        value.$bindItem,
        `${path}.$bindItem`,
        UI_APP_LIMITS.pathChars,
      );
      validateItemField(field, scope, `${path}.$bindItem`);
      const resolved = itemValueOf(scope, field);
      if (resolved !== undefined)
        checkType(resolved, prop, `${path}.$bindItem`);
      return;
    }
    default:
      fail(path, `unknown expression "${String(key)}"`);
  }
}

/** Check a literal prop value. */
function validateLiteral(
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
function validateValue(
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
function validateArrayItems(
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
function validateLooseValue(value: unknown, scope: Scope, path: string): void {
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
function validateCondition(value: unknown, scope: Scope, path: string): void {
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

/** Check one element's `on` map. */
function validateOn(
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
function validateAction(value: unknown, scope: Scope, path: string): void {
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

/** Checks that need the element's children or its initial values. */
function postCheck(
  type: string,
  props: Readonly<Record<string, unknown>>,
  children: readonly string[],
  elements: Readonly<Record<string, unknown>>,
  scope: Scope,
  path: string,
): void {
  if (type === "Tabs") {
    const value = props.value;
    if (value === undefined || !isExpression(value)) return;
    const bound = value.$bindState;
    if (typeof bound !== "string") return;
    const active = valueAtPath(scope.state, bound);
    const labels = children.map((child) => {
      const element = recordOf(elements[child], `spec.elements.${child}`);
      const propsOfChild = recordOf(
        element.props ?? {},
        `spec.elements.${child}.props`,
      );
      return propsOfChild.label;
    });
    if (typeof active === "string" && !labels.includes(active)) {
      fail(`${path}.props.value`, `the active tab "${active}" names no <Tab>`);
    }
    return;
  }
  if (type === "Input" || type === "Textarea") {
    if (props.label === undefined && props.placeholder === undefined) {
      fail(`${path}.props`, `<${type}> needs a label or placeholder`);
    }
    return;
  }
  if (type === "Select") {
    const value = props.value;
    if (value === undefined || !isExpression(value)) return;
    const bound = value.$bindState;
    if (typeof bound !== "string") return;
    const active = valueAtPath(scope.state, bound);
    const options = literalValue(props.options as UiAppValue, scope);
    if (!Array.isArray(options)) return;
    const values = options
      .filter(
        (option): option is Record<string, unknown> =>
          option !== null &&
          typeof option === "object" &&
          !Array.isArray(option),
      )
      .map((option) => option.value);
    if (!values.some((option) => Object.is(option, active))) {
      fail(
        `${path}.props.value`,
        `the value ${JSON.stringify(active)} names no option`,
      );
    }
    return;
  }
  if (type === "Table") {
    const columns = literalValue(props.columns as UiAppValue, scope);
    const rows = literalValue(props.rows as UiAppValue, scope);
    if (!Array.isArray(columns) || !Array.isArray(rows)) return;
    rows.forEach((row, index) => {
      if (Array.isArray(row) && row.length !== columns.length) {
        fail(
          `${path}.props.rows[${index}]`,
          `${row.length} cells for ${columns.length} columns`,
        );
      }
    });
    return;
  }
  if (type === "Flow") {
    const nodes = literalValue(props.nodes as UiAppValue, scope);
    const edges = literalValue(props.edges as UiAppValue, scope);
    if (!Array.isArray(nodes) || !Array.isArray(edges)) return;
    const ids = new Set<string>();
    nodes.forEach((node, index) => {
      if (node === null || typeof node !== "object" || Array.isArray(node))
        return;
      const id = (node as Record<string, unknown>).id;
      if (typeof id === "string") {
        if (ids.has(id)) {
          fail(`${path}.props.nodes[${index}].id`, `duplicate node id "${id}"`);
        }
        ids.add(id);
      }
    });
    edges.forEach((edge, index) => {
      if (edge === null || typeof edge !== "object" || Array.isArray(edge))
        return;
      const from = (edge as Record<string, unknown>).from;
      const to = (edge as Record<string, unknown>).to;
      if (typeof from === "string" && !ids.has(from)) {
        fail(`${path}.props.edges[${index}].from`, `unknown node "${from}"`);
      }
      if (typeof to === "string" && !ids.has(to)) {
        fail(`${path}.props.edges[${index}].to`, `unknown node "${to}"`);
      }
      if (typeof from === "string" && from === to) {
        fail(`${path}.props.edges[${index}]`, "an edge connects two nodes");
      }
    });
  }
}

/** The value a path names, or a failure. */
function stateValueOf(path: string, scope: Scope, at: string): unknown {
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
function validateItemField(field: string, scope: Scope, path: string): void {
  if (scope.items === null) return;
  if (field === "") return;
  for (const item of scope.items) {
    if (itemValue(item, field) === undefined) {
      fail(path, `the repeated items have no field "${field}"`);
    }
  }
}

/** Check one template's references against the state and the repeat. */
function validateTemplate(template: string, scope: Scope, path: string): void {
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

/** The field of the current repeated item. */
function itemValueOf(scope: Scope, field: string): unknown {
  if (scope.items === null) return undefined;
  const first = scope.items[0];
  if (first === undefined) return undefined;
  return itemValue(first, field);
}

/** A value when every expression in it can be resolved before the card runs;
 * undefined when one cannot. Used for checks that compare a prop with the
 * initial state. */
function literalValue(value: UiAppValue, scope: Scope): unknown {
  if (isExpression(value)) {
    const expression = value as Record<string, unknown>;
    if (typeof expression.$state === "string") {
      return valueAtPath(scope.state, expression.$state);
    }
    if (typeof expression.$item === "string") {
      return itemValueOf(scope, expression.$item);
    }
    if (typeof expression.$bindState === "string") {
      return valueAtPath(scope.state, expression.$bindState);
    }
    if (typeof expression.$bindItem === "string") {
      return itemValueOf(scope, expression.$bindItem);
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const child of value) {
      const resolved = literalValue(child as UiAppValue, scope);
      if (resolved === undefined) return undefined;
      items.push(resolved);
    }
    return items;
  }
  if (value !== null && typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const item = literalValue(child as UiAppValue, scope);
      if (item === undefined) return undefined;
      resolved[key] = item;
    }
    return resolved;
  }
  return value;
}

/** The state path a Repeat's `over` names, or null when it is not a state
 * path. */
function statePathOf(value: unknown): string | null {
  if (!isExpression(value)) return null;
  return typeof value.$state === "string" ? value.$state : null;
}

/** Check a resolved value against the prop's literal kind. */
function checkType(value: unknown, prop: UiAppProp, path: string): void {
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
function validateState(state: Readonly<Record<string, unknown>>): void {
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
function validateJsonKeys(value: unknown, path: string): void {
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
function jsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 1;
  if (Array.isArray(value)) {
    return 1 + Math.max(0, ...value.map((child) => jsonDepth(child)));
  }
  return (
    1 + Math.max(0, ...Object.values(value).map((child) => jsonDepth(child)))
  );
}

/** One object, not an array. */
function recordOf(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

/** One string within a length. */
function stringOf(value: unknown, path: string, limit: number): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length > limit) {
    fail(path, `${value.length} characters; the limit is ${limit}`);
  }
  return value;
}

/** Whether a value is a JSON primitive. */
function isPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** One finite number. */
function numberOf(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "must be a number");
  }
  return value;
}

/** One array of strings. */
function stringArrayOf(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array of strings");
  return value.map((item, index) => {
    if (typeof item !== "string") fail(`${path}[${index}]`, "must be a string");
    return item;
  });
}

/** One key that is safe to use as an object key. */
function keyOf(value: string, path: string): void {
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

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every component in the catalog, for tests that compare the renderer's
 * registry with the vocabulary. */
export function appComponentNames(): string[] {
  return UI_APP_COMPONENTS.map((component) => component.name);
}
