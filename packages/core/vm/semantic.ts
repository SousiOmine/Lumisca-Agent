/**
 * The stella machine's semantic tools: `vm_find`, `vm_do` and `vm_wait`.
 *
 * The screen tools (`vm_screenshot` / `vm_act`) work in pixels: the model
 * reads a position off an image and hands it back. That is the only way to
 * drive something with no widget model — a canvas, a game, a custom-drawn
 * surface — and it is a poor way to press a button: the click lands on
 * whatever occupies that pixel, which may not be the control the picture was
 * read from, and the result says only "clicked at (x, y)".
 *
 * These three tools address the machine's widgets by what they ARE. An
 * element found by role and name is the element acted on, or the action
 * fails; a result carries the state that was read back, so "the click did
 * nothing" is visible rather than assumed. None of it moves the pointer: the
 * toolkit's own action is what runs, so the user watching the screen through
 * VNC does not see their cursor jump.
 *
 * THE TREE IS READ INSIDE THE MACHINE. Everything here is one `podman exec`
 * of a Python helper (`vm/container/a11y.py`) that walks AT-SPI and
 * prints one JSON object; this layer parses that and turns it into a tool
 * result. The helper is where the platform knowledge lives (roles, actions,
 * the keyboard fallback for a web field), because the tree is only reachable
 * from inside.
 *
 * REFS ARE SNAPSHOTS. `vm_find` answers refs like `@s12345:e7`; `vm_do` acts
 * on one and the helper refuses a ref whose element no longer matches the
 * role and name it was found under. That is the contract the agent is told:
 * find, act, and find again when the window has changed underneath.
 */
import { CoreError } from "../errors.ts";
import { TOOL_VM_DO, TOOL_VM_FIND, TOOL_VM_WAIT } from "../shared/mod.ts";
import {
  integer,
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "../tools/schema.ts";
import { requireOneOf } from "../tools/validate.ts";
import { VM_A11Y_HELPER } from "./contract.ts";
import type { VmExec } from "./container.ts";

/** One helper call is a `podman exec` into a machine that is already running;
 * a walk of a large window is the slow case. */
const HELPER_TIMEOUT_MS = 60_000;
/** The helper's answer is a JSON tree of one window; this bounds a runaway
 * (a walk of an enormous table) without cutting a real one. */
const HELPER_OUTPUT_LIMIT = 4 * 1024 * 1024;
/** Waits are bounded so a condition that never holds cannot hold the run. */
const MAX_WAIT_MS = 30_000;

const findSchema = object({
  app: string(
    "The application to read, by the name it has on the accessibility bus: " +
      'usually the program name ("chromium", "zenity", "nautilus"). The ' +
      "result lists the running names when nothing matches.",
  ),
  role: optional(string(
    'The element kind, e.g. "push button", "entry", "check box", ' +
      '"combo box", "menu item", "page tab", "link", "table cell", ' +
      '"label". Omit to match any kind.',
  )),
  name: optional(string(
    "Text the element's name contains (case-insensitive). This is what the " +
      "control says: a button's label, a field's label.",
  )),
  text: optional(string(
    "Text the element's name OR its text content contains. Use it to find a " +
      "row or a cell by what it shows.",
  )),
  limit: optional(integer("How many matches to return (default 20, max 60)", {
    min: 1,
    max: 60,
  })),
  actionable: optional(string(
    'Whether to list only elements that can be acted on (default "yes"). ' +
      '"no" also reports static text and containers, e.g. to read a page.',
  )),
});

const doSchema = object({
  ref: string(
    "The ref find returned for the element (e.g. @s12345:e3). A ref is valid " +
      "while that snapshot is the latest one: if the window changed, find " +
      "again.",
  ),
  action: string(
    'The action: "click" | "set_value" | "check" | "uncheck" | "select" | ' +
      '"focus" | "key" | "scroll".',
  ),
  value: optional(string(
    "set_value: the text to write. select: the option's visible name.",
  )),
  key: optional(string(
    "key: the key or combination by X11 name, e.g. `Return`, `Escape`, " +
      "`Tab`, `ctrl+a`, `ctrl+v`.",
  )),
  vertical: optional(integer(
    "scroll: notches to scroll, positive for down (default 0)",
  )),
  horizontal: optional(integer(
    "scroll: notches to scroll, positive for right (default 0)",
  )),
});

const waitSchema = object({
  ms: optional(integer(
    "Plain delay in milliseconds (max 30000). Omit to wait for a condition.",
    { min: 0, max: MAX_WAIT_MS },
  )),
  app: optional(string("The application to watch (a condition needs it).")),
  role: optional(string("Condition: the element kind to wait for.")),
  name: optional(string("Condition: text the element's name contains.")),
  text: optional(string(
    "Condition: text in the element's name or content.",
  )),
  gone: optional(string(
    'Condition: wait for the element to DISAPPEAR instead (default "no"). ' +
      "Use it after an action that closes a dialog.",
  )),
  timeout_ms: optional(integer(
    "How long to wait for the condition (default 5000, max 30000)",
    { min: 100, max: MAX_WAIT_MS },
  )),
});

export interface SemanticToolsOptions {
  /** The machine's exec seam: every call crosses into the container. */
  exec: VmExec;
}

/** Build the semantic tool family. */
export function createVmSemanticTools(
  options: SemanticToolsOptions,
): Tool[] {
  return [
    createFindTool(options),
    createDoTool(options),
    createWaitTool(options),
  ];
}

/** One helper call: the request as JSON, the answer parsed. */
async function callHelper(
  exec: VmExec,
  request: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const result = await exec(
    ["python3", VM_A11Y_HELPER, JSON.stringify(request)],
    {
      timeoutMs: HELPER_TIMEOUT_MS,
      maxOutput: HELPER_OUTPUT_LIMIT,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  if (result.timedOut) {
    throw new CoreError(
      "The machine did not answer in time: the screen may be wedged, or the " +
        "window is enormous. Take a vm_screenshot to see what it is doing.",
      "unavailable",
    );
  }
  if (result.exitCode !== 0 && result.stdout.trim() === "") {
    // The helper answers its own failures as JSON on stdout, so an empty
    // stdout means it never got that far — a missing interpreter, a missing
    // package, a machine that is not the contract's.
    throw new CoreError(
      "The machine's accessibility helper could not run: " +
        (result.stderr.trim() || `exit code ${result.exitCode}`),
      "unavailable",
    );
  }
  let answer: unknown;
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    throw new CoreError(
      "The machine's accessibility helper answered something that is not " +
        "JSON: " + result.stdout.slice(0, 400),
      "unavailable",
    );
  }
  if (typeof answer !== "object" || answer === null) {
    throw new CoreError(
      "The machine's accessibility helper answered no object",
      "unavailable",
    );
  }
  const record = answer as Record<string, unknown>;
  if (typeof record.error === "string") {
    // The helper's sentence names what went wrong in the machine's terms
    // ("the element is gone", "no running application matches ..."), which is
    // exactly what the agent needs to decide its next move.
    throw new CoreError(record.error, "invalid");
  }
  return record;
}

/** The names/roles line the tools report when the caller asked for something
 * that is not there: telling a mistyped role from an empty window is the
 * difference between "look again" and "that control is not there". */
function describeRoles(answer: Record<string, unknown>): string {
  const roles = answer.roles_present;
  if (!Array.isArray(roles) || roles.length === 0) return "";
  return `\nRoles present in that window: ${roles.join(", ")}.`;
}

function createFindTool(
  { exec }: SemanticToolsOptions,
): Tool<typeof findSchema> {
  return {
    name: TOOL_VM_FIND,
    label: "VM Find",
    description:
      "Find elements of an application in the machine by role, name or text, " +
      "and get a ref to act on with vm_do. This is how a GUI is read here: " +
      "the result names each control (role, name, value, states) instead of " +
      "showing a picture, so it is cheaper and more precise than " +
      "vm_screenshot. Refused on elements that are the same in name and " +
      "role: the page or window has changed, so find again.\n" +
      'Example: app "chromium", role "push button", name "Sign in". ' +
      "A miss lists the roles that window does have.",
    parameters: findSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const request: Record<string, unknown> = {
        command: "find",
        app: params.app,
        actionable: params.actionable !== "no",
      };
      if (params.role !== undefined) request.role = params.role;
      if (params.name !== undefined) request.name = params.name;
      if (params.text !== undefined) request.text = params.text;
      if (params.limit !== undefined) request.limit = params.limit;
      const answer = await callHelper(exec, request, signal);

      const matches = Array.isArray(answer.matches) ? answer.matches : [];
      if (matches.length === 0) {
        throw new CoreError(
          `No element in "${params.app}" matches` +
            `${params.role === undefined ? "" : ` role "${params.role}"`}` +
            `${params.name === undefined ? "" : ` name "${params.name}"`}` +
            `${params.text === undefined ? "" : ` text "${params.text}"`}.` +
            describeRoles(answer),
          "not_found",
        );
      }

      const lines: string[] = [];
      lines.push(
        `${matches.length} match(es) in "${params.app}"` +
          (answer.complete === false
            ? " (the window was larger than the walk budget: some elements " +
              "were not read)"
            : "") +
          ":",
      );
      for (const match of matches) {
        lines.push(formatMatch(match as Record<string, unknown>));
      }
      lines.push(
        "Act on one with vm_do(ref, action). A ref is valid only against the " +
          "snapshot it came from: after the window changes, find again.",
      );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          app: params.app,
          snapshot: answer.snapshot,
          count: matches.length,
          matches,
        },
      };
    },
  };
}

/** One match, as the agent reads it: the ref first (it is what it needs), then
 * what the element is and what can be done to it. */
function formatMatch(match: Record<string, unknown>): string {
  const parts = [`- ${match.ref} ${match.role}`];
  if (typeof match.name === "string" && match.name !== "") {
    parts.push(`"${match.name}"`);
  }
  if (
    typeof match.text === "string" && match.text !== "" &&
    match.text !== match.name
  ) {
    parts.push(`text: ${match.text}`);
  }
  const states = Array.isArray(match.states) ? match.states : [];
  // `enabled` absent is how a disabled control reads on this bus; spelling it
  // out stops a click on a greyed-out button from looking like a tool bug.
  const flags: string[] = [];
  if (!states.includes("enabled")) flags.push("disabled");
  for (const state of states) {
    if (state === "checked" || state === "focused") flags.push(state);
  }
  if (flags.length > 0) parts.push(`[${flags.join(", ")}]`);
  const bounds = match.bounds as Record<string, unknown> | null | undefined;
  if (bounds !== null && bounds !== undefined) {
    parts.push(
      `at (${bounds.x}, ${bounds.y}) ${bounds.width}x${bounds.height}`,
    );
  }
  const actions = Array.isArray(match.actions) ? match.actions : [];
  const usable = actions.filter((action) => action !== "showContextMenu");
  if (usable.length > 0) parts.push(`actions: ${usable.join(", ")}`);
  return parts.join(" ");
}

function createDoTool({ exec }: SemanticToolsOptions): Tool<typeof doSchema> {
  return {
    name: TOOL_VM_DO,
    label: "VM Do",
    description:
      "Perform one action on an element vm_find returned: click, set_value, " +
      "check, uncheck, select, focus, key or scroll. The action goes through " +
      "the application's own accessibility interface, so it does not move the " +
      "pointer and cannot land on a neighbouring element — and the result " +
      "reads the element back, reporting delivered_verified (the state " +
      "changed) or delivered_unverified (the app accepted it but nothing " +
      "readable changed: check with vm_find before repeating, a second click " +
      "may act twice).\n" +
      "set_value writes a text field; key sends keys to whatever has the " +
      "focus (use focus first).",
    parameters: doSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const action = params.action.trim();
      requireOneOf(
        "action",
        action,
        [
          "click",
          "set_value",
          "check",
          "uncheck",
          "select",
          "focus",
          "key",
          "scroll",
        ] as const,
      );
      const request: Record<string, unknown> = {
        command: "do",
        ref: params.ref,
        action,
      };
      if (action === "set_value") {
        if (params.value === undefined) {
          throw new CoreError(
            "set_value needs the text to write (value)",
            "invalid",
          );
        }
        request.value = params.value;
      }
      if (action === "select") {
        if (params.value === undefined) {
          throw new CoreError(
            "select needs the option's name (value)",
            "invalid",
          );
        }
        request.value = params.value;
      }
      if (action === "key") {
        if (params.key === undefined || params.key.trim() === "") {
          throw new CoreError(
            "key needs a key name (e.g. `Return`, `ctrl+a`)",
            "invalid",
          );
        }
        request.key = params.key;
      }
      if (action === "scroll") {
        const vertical = params.vertical ?? 0;
        const horizontal = params.horizontal ?? 0;
        if (vertical === 0 && horizontal === 0) {
          throw new CoreError(
            "scroll needs a vertical or horizontal amount",
            "invalid",
          );
        }
        request.vertical = vertical;
        request.horizontal = horizontal;
      }
      const answer = await callHelper(exec, request, signal);
      if (answer.unchanged === true) {
        return {
          content: [{
            type: "text",
            text: `The element was already in that state; nothing was done.`,
          }],
          details: { action, unchanged: true, states: answer.states },
        };
      }
      return {
        content: [{ type: "text", text: formatDoAnswer(action, answer) }],
        details: { action, ...answer },
      };
    },
  };
}

/** The sentence a `vm_do` result carries: what happened, and whether the app
 * showed it. */
function formatDoAnswer(
  action: string,
  answer: Record<string, unknown>,
): string {
  const delivery = String(answer.delivery ?? "delivered_unverified");
  const after = answer.after as Record<string, unknown> | undefined;
  const lines = [`${action}: ${delivery}`];
  if (after !== undefined) {
    if (typeof after.name === "string" && after.name !== "") {
      lines.push(`- name: ${after.name}`);
    }
    if (typeof after.text === "string" && after.text !== "") {
      lines.push(`- value: ${after.text}`);
    }
    const states = Array.isArray(after.states) ? after.states : [];
    if (states.length > 0) lines.push(`- states: ${states.join(", ")}`);
  }
  if (delivery !== "delivered_verified") {
    lines.push(
      "- the application accepted the action but nothing readable changed. " +
        "Look before repeating it: a second click may act twice.",
    );
  }
  return lines.join("\n");
}

function createWaitTool(
  { exec }: SemanticToolsOptions,
): Tool<typeof waitSchema> {
  return {
    name: TOOL_VM_WAIT,
    label: "VM Wait",
    description:
      "Wait before looking again. Either a plain delay (ms) or a condition " +
      "on the accessibility tree: an element with this role/name/text " +
      'appearing (or disappearing, with gone "yes"). Use a condition ' +
      "instead of a guessed delay after anything asynchronous — a page " +
      "loading, a dialog opening, a build finishing — so the next vm_find " +
      "reads a settled screen.",
    parameters: waitSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const condition = params.app !== undefined &&
        (params.role !== undefined || params.name !== undefined ||
          params.text !== undefined);
      const request: Record<string, unknown> = { command: "wait" };
      if (params.ms !== undefined && !condition) {
        request.ms = params.ms;
      } else {
        if (params.app === undefined) {
          throw new CoreError(
            "wait needs either ms (a plain delay) or app with role/name/text " +
              "(a condition)",
            "invalid",
          );
        }
        if (!condition) {
          throw new CoreError(
            "a wait condition needs at least one of role, name or text",
            "invalid",
          );
        }
        request.app = params.app;
        if (params.role !== undefined) request.role = params.role;
        if (params.name !== undefined) request.name = params.name;
        if (params.text !== undefined) request.text = params.text;
        if (params.gone === "yes") request.gone = true;
        if (params.timeout_ms !== undefined) {
          request.timeout_ms = params.timeout_ms;
        }
      }
      const answer = await callHelper(exec, request, signal);
      if (answer.waited_ms !== undefined && answer.present === undefined) {
        return {
          content: [{ type: "text", text: `Waited ${answer.waited_ms} ms.` }],
          details: { waited_ms: answer.waited_ms },
        };
      }
      const present = answer.present === true;
      return {
        content: [{
          type: "text",
          text: present
            ? `The element is present (waited ${answer.waited_ms} ms).`
            : `The element is gone (waited ${answer.waited_ms} ms).`,
        }],
        details: { present, waited_ms: answer.waited_ms },
      };
    },
  };
}
