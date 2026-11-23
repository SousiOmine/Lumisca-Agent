/**
 * Reading one app card's JSON.
 *
 * The model writes the spec, so it is checked before a component sees it: an
 * unreadable card is a message for the model and the reader, not a half-drawn
 * card. This module is the entry point only; the checks live in `validate/`.
 *
 * - `errors.ts` — the refusal and its message,
 * - `values.ts` — the scope and the JSON primitives every check uses,
 * - `expression.ts` — expressions, literals, conditions and loose values,
 * - `props.ts` — one element's props and the checks that need its children,
 * - `action.ts` — the `on` actions an element can run,
 * - `graph.ts` — the element tree, its reachability and its size.
 */
import { UI_APP_COMPONENTS } from "./catalog.ts";
import { UI_APP_LIMITS } from "./limits.ts";
import type { UiAppParseResult } from "./types.ts";
import { AppSpecError, messageOf } from "./validate/errors.ts";
import { validateSpec } from "./validate/graph.ts";

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

/** Every component in the catalog, for tests that compare the renderer's
 * registry with the vocabulary. */
export function appComponentNames(): string[] {
  return UI_APP_COMPONENTS.map((component) => component.name);
}
