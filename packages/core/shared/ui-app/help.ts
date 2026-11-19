/**
 * The app card as the MODEL reads it.
 *
 * This is the body of the `app-ui` skill, and the experimental switch can
 * put it in every main system prompt instead (see
 * LumiscaCore.setAppUiInSystemPrompt). The grammar is large, so by default a
 * session pays for it only when the model is about to write an app card. The
 * catalog below is the same object the parser and the renderer use, so a
 * component added there appears here without a second list to forget.
 */
import {
  UI_APP_COMPONENTS,
  type UiAppComponent,
  type UiAppProp,
} from "./catalog.ts";
import { UI_APP_LIMITS } from "./limits.ts";

/** The card paragraph both placements share: only the middle sentence says
 * where the grammar lives. */
function uiHelp(middle: string): string {
  return [
    "A UI card is written into your reply, not sent by a tool call: put it in a fenced code block whose info string is `ui`, on its own lines, and the app draws the card where the block sits.",
    middle,
    "The rest of the reply is ordinary markdown, so words may come before and after the card.",
  ].join(" ");
}

/** The short pointer in every prompt whose reply a person reads.
 *
 * The full grammar is the `app-ui` skill: a session pays for it only when
 * it is about to write an app card. This sentence is what tells the model
 * that the block exists and which skill teaches it. */
export const UI_HELP: string = uiHelp(
  "The block holds one JSON spec; load the `app-ui` skill for the spec, components and actions.",
);

/** The pointer used when the guide travels in the same prompt (the
 * experimental switch): the same paragraph, except that it points at the
 * text below rather than at a skill. The skill stays available, so a prompt
 * elsewhere that says "load the app-ui skill" still works. */
export const UI_HELP_INLINE: string = uiHelp(
  "The block holds one JSON spec; the spec, components and actions are described below.",
);

/** The skill's SKILL.md body. */
export function appHelp(): string {
  const lines: string[] = [
    "# App cards",
    "",
    "An app card is a large interactive UI inside a chat reply. It is written",
    "as JSON in a fenced block whose info string is `ui`:",
    "",
    "```ui",
    "{ ... }",
    "```",
    "",
    "Nothing but the JSON goes in the block. The reply around it is ordinary",
    "markdown. The app is part of the message: its state lives in the page",
    "while the message is open, and a reload starts it again from `state`.",
    "",
    "Use an app card when the reader must DO something over several steps:",
    "type, toggle, switch tabs, add rows, filter a list. For a static table",
    "or a short question, plain markdown is smaller and better: an app card",
    "is for controls and state, not for prose.",
    "",
    "## Spec",
    "",
    "```json",
    "{",
    '  "version": 1,',
    '  "title": "Tasks",',
    '  "description": "Optional line under the title",',
    '  "state": { "draft": "", "items": [] },',
    '  "root": "screen",',
    '  "elements": {',
    '    "screen": { "type": "Screen", "children": ["title"] },',
    '    "title": { "type": "Heading", "props": { "text": "Tasks" } }',
    "  }",
    "}",
    "```",
    "",
    "`version` is 1. `state` is the initial state: a JSON object whose keys",
    "are the paths the card reads and writes. `root` names one element and",
    "must be a `Screen`. `elements` is a flat map of id to element. Every",
    "element has `type`; `props`, `children`, `visible` and `on` are",
    "optional. An element is reachable from exactly one parent, and every",
    "element must be reachable from the root.",
    "",
    "## Values",
    "",
    "A prop value is a literal, a plain object or array, or one expression:",
    "",
    '- `{ "$state": "/path" }` reads the state.',
    '- `{ "$item": "field" }` reads a field of the repeated item. Use',
    '  `""` for the item itself.',
    '- `{ "$index": true }` reads the repeat index.',
    '- `{ "$template": "Hello ${/name}" }` interpolates. `${/path}` reads',
    "  state, `${item.field}` reads the repeated item, `${index}` reads the",
    "  index. Write `$${` for a literal `${`.",
    '- `{ "$cond": condition, "$then": value, "$else": value }` picks a',
    "  branch.",
    '- `{ "$bindState": "/path" }` is an input\'s two-way binding.',
    '- `{ "$bindItem": "field" }` binds a field of the repeated item. It',
    "  needs a Repeat whose `over` is a state path.",
    "",
    "An expression object carries exactly one `$…` key and nothing else.",
    "A state path starts with `/` and names a key that exists in `state`.",
    "Every `$item` field must exist on every item of the repeated array when",
    "that array is known.",
    "",
    "## Conditions",
    "",
    "`visible` and `$cond` take a condition:",
    "",
    "- `true` or `false`.",
    '- `{ "$state": "/path" }` is true when the value is truthy.',
    '- `{ "$state": "/path", "eq": value }` and `neq` compare.',
    "- `gt`, `gte`, `lt`, `lte` compare numbers.",
    '- `{ "$state": "/path", "not": true }` negates.',
    '- `{ "$item": "done" }` and `{ "$index": true, "gt": 0 }` read',
    "  the repeat.",
    '- `{ "$and": [condition, condition] }` and `$or` combine.',
    "",
    "A condition names exactly one subject and at most one comparison.",
    "",
    "## Actions",
    "",
    "`on` maps an event to one action or an array of actions. Actions run in",
    "order and each sees the state the previous one left.",
    "",
    '- `{ "action": "setState", "path": "/x", "value": value }`',
    "  sets. `op` may be `set`, `toggle`, `increment` with `by`, `append`",
    "  with `value`, or `remove` with `index`.",
    '- `{ "action": "resetState" }` returns to the initial state.',
    '- `{ "action": "sendMessage", "text": value }` sends the resolved',
    "  text as the user's next message. This is the only action that reaches",
    "  the model. Put the values the model needs into the text: it cannot see",
    "  the card's state.",
    "",
    "A `Button` uses `press`. Inputs use `change`; typing already writes the",
    "bound state, so `change` is for extra work.",
    "",
    "## Components",
    "",
  ];
  for (const component of UI_APP_COMPONENTS) {
    lines.push(...componentLines(component));
  }
  lines.push(
    "## Limits",
    "",
    `- The whole JSON: ${UI_APP_LIMITS.chars} characters.`,
    `- Elements: ${UI_APP_LIMITS.elements}; depth: ${UI_APP_LIMITS.depth};`,
    `  expanded elements after repeats: ${UI_APP_LIMITS.expandedElements}.`,
    `- One Repeat: ${UI_APP_LIMITS.repeatItems} items.`,
    `- State: ${UI_APP_LIMITS.stateKeys} keys and ${UI_APP_LIMITS.stateChars} characters.`,
    `- Text: ${UI_APP_LIMITS.textChars} characters; labels: ${UI_APP_LIMITS.labelChars}.`,
    "",
    "## Rules",
    "",
    "- JSON only. No HTML, CSS, URLs, scripts or event handler code.",
    "- Strings are drawn as text. Markdown is not rendered inside a card.",
    "- The state is not saved. Do not use it for durable data.",
    "- To change an app, write a new reply with a new `ui` block.",
    "- A typo is refused with the element path. Fix the spec rather than",
    "  leaving a control that does nothing.",
    "",
    "## Example",
    "",
    "```ui",
    "{",
    '  "version": 1,',
    '  "title": "Tasks",',
    '  "state": { "draft": "", "items": [{ "name": "Estimate", "done": false }] },',
    '  "root": "screen",',
    '  "elements": {',
    '    "screen": { "type": "Screen", "children": ["title", "form", "list"] },',
    '    "title": { "type": "Heading", "props": { "text": "Today", "level": 2 } },',
    '    "form": { "type": "Row", "props": { "gap": "s" }, "children": ["draft", "add"] },',
    '    "draft": {',
    '      "type": "Input",',
    '      "props": { "placeholder": "New task", "value": { "$bindState": "/draft" } }',
    "    },",
    '    "add": {',
    '      "type": "Button",',
    '      "props": { "label": "Add", "variant": "primary" },',
    '      "on": {',
    '        "press": [',
    "          {",
    '            "action": "setState",',
    '            "path": "/items",',
    '            "op": "append",',
    '            "value": { "name": { "$state": "/draft" }, "done": false }',
    "          },",
    '          { "action": "setState", "path": "/draft", "value": "" }',
    "        ]",
    "      }",
    "    },",
    '    "list": {',
    '      "type": "Repeat",',
    '      "props": { "over": { "$state": "/items" } },',
    '      "children": ["row"]',
    "    },",
    '    "row": {',
    '      "type": "Checkbox",',
    '      "props": {',
    '        "label": { "$template": "${item.name}" },',
    '        "checked": { "$bindItem": "done" }',
    "      }",
    "    }",
    "  }",
    "}",
    "```",
    "",
  );
  return lines.join("\n");
}

/** One component's section of the guide. */
function componentLines(component: UiAppComponent): string[] {
  const lines = [`### ${component.name}`, "", component.description, ""];
  const props = Object.entries(component.props);
  if (props.length === 0) {
    lines.push("Props: none.");
  } else {
    lines.push("Props:");
    for (const [name, prop] of props) {
      lines.push(`- \`${name}\`: ${propText(prop)}`);
    }
  }
  if (component.children !== undefined) {
    lines.push("", `Children: 1 to ${component.children.max} blocks.`);
  } else {
    lines.push("", "Children: none.");
  }
  if (component.events !== undefined && component.events.length > 0) {
    lines.push(`Events: ${component.events.join(", ")}.`);
  }
  lines.push("");
  return lines;
}

/** One prop's type and rules, in the guide's compact form. */
function propText(prop: UiAppProp): string {
  const parts: string[] = [];
  switch (prop.kind) {
    case "string":
      parts.push("string");
      break;
    case "text":
      parts.push("string or number");
      break;
    case "number":
      parts.push("number");
      break;
    case "boolean":
      parts.push("boolean");
      break;
    case "enum":
      parts.push(`one of ${prop.values?.join(", ") ?? ""}`);
      break;
    case "array":
      parts.push(`array of ${prop.items ?? "values"}`);
      break;
    case "object":
      parts.push("object");
      break;
    case "any":
      parts.push("any JSON");
      break;
  }
  if (prop.required === true) parts.push("required");
  if (prop.expression === true) parts.push("expression allowed");
  if (prop.bind === "state") parts.push("must be $bindState");
  if (prop.bind === "item") parts.push("must be $bindItem");
  if (prop.bind === "both") parts.push("must be $bindState or $bindItem");
  if (prop.min !== undefined || prop.max !== undefined) {
    parts.push(`range ${prop.min ?? "-"} to ${prop.max ?? "-"}`);
  }
  parts.push(prop.description);
  return parts.join("; ");
}
