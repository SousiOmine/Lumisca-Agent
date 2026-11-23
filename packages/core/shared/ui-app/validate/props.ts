/**
 * Checking one element's props against the catalog, and the checks that need
 * its children.
 *
 * A prop that the catalog does not name is refused rather than ignored, so a
 * typo cannot become a silently missing control. `<Repeat>` is the only
 * element whose props change the scope its children are drawn in.
 */
import type { UiAppComponent, UiAppProp } from "../catalog.ts";
import { isExpression } from "../resolve.ts";
import { valueAtPath } from "../state.ts";
import type { UiAppValue } from "../types.ts";
import { fail } from "./errors.ts";
import {
  validateBinding,
  validateExpression,
  validateLiteral,
} from "./expression.ts";
import { literalValue, recordOf, type Scope, statePathOf } from "./values.ts";

/** Check every written prop and return the scope the children are drawn
 * with. Only `<Repeat>` changes it. */
export function validateProps(
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
export function validateProp(
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

/** Checks that need the element's children or its initial values. */
export function postCheck(
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
