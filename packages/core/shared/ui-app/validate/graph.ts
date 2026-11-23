/**
 * Checking one spec's element graph.
 *
 * A card is a flat element map drawn as one tree from `root`, so the tree is
 * checked before anything is drawn from it: every element reachable exactly
 * once, no cycle, no second parent, the depth and size limits, and how many
 * blocks the repeats expand to. Child context (which Repeat an element sits
 * in) is carried in a `Scope` from `values.ts`.
 */
import { UI_APP_COMPONENT_BY_NAME, UI_APP_ROOT_TYPE } from "../catalog.ts";
import { UI_APP_LIMITS } from "../limits.ts";
import type { UiAppSpec, UiAppValue } from "../types.ts";
import { validateOn } from "./action.ts";
import { fail } from "./errors.ts";
import { validateCondition } from "./expression.ts";
import { postCheck, validateProps } from "./props.ts";
import {
  keyOf,
  literalValue,
  recordOf,
  type Scope,
  statePathOf,
  stringArrayOf,
  stringOf,
  validateState,
} from "./values.ts";

/** Check one parsed value and return it as a spec. */
export function validateSpec(raw: unknown): UiAppSpec {
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
export function expandedCount(
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
export function visitElement(
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
