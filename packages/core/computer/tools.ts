/**
 * The computer-use tools: computer_screenshot / computer_act /
 * computer_list_windows. They are never preloaded into the LLM context — the
 * session pool seeds them into the session's tool registry (discoverable via
 * tool_search), the same contract as MCP, browser-lab and PDF tools. Without
 * a host nothing is seeded at all; the host is resolved through a provider at
 * execute time, so a feature toggled off after a session opened fails its
 * next call with a clear error instead of acting on a stale reference.
 *
 * THE COORDINATE CONTRACT is the one thing to get right here. The model
 * reads pixel positions off the image it was given, so `computer_act` takes
 * coordinates in THAT image's pixels and this layer converts them to screen
 * pixels through the view recorded by the most recent screenshot
 * (`screen = round(image / scale) + origin`). A capture is scaled to stay
 * inside the vision providers' image budget (see image.ts), and asking the
 * model to do that division itself is where computer use usually goes wrong.
 * Taking a screenshot first is therefore mandatory — a coordinate action
 * without a view fails instead of guessing.
 *
 * Every result repeats the mapping and the resolved screen coordinates, so
 * a mis-click is diagnosable from the transcript alone.
 */
import { CoreError } from "../errors.ts";
import { bytesToBase64 } from "../base64.ts";
import {
  TOOL_COMPUTER_ACT,
  TOOL_COMPUTER_LIST_WINDOWS,
  TOOL_COMPUTER_SCREENSHOT,
} from "../shared/mod.ts";
import {
  integer,
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "../tools/schema.ts";
import {
  DEFAULT_MAX_DIMENSION,
  encodeCapture,
  MAX_MAX_DIMENSION,
  MIN_MAX_DIMENSION,
} from "./image.ts";
import type {
  ComputerAction,
  ComputerActionResult,
  ComputerHost,
  DisplayInfo,
  MouseButton,
  Point,
  Rect,
  WindowInfo,
} from "./types.ts";

/** The three tool names of the computer-use family. The session pool seeds
 * and removes them with this list. */
export const COMPUTER_TOOL_NAMES: readonly string[] = [
  TOOL_COMPUTER_SCREENSHOT,
  TOOL_COMPUTER_ACT,
  TOOL_COMPUTER_LIST_WINDOWS,
];

/** Longest text one `type` action may send. Longer payloads are a sign the
 * agent should write a file (or use the clipboard) instead. */
export const MAX_TYPE_CHARS = 4096;
/** Longest `wait` action. */
export const MAX_WAIT_MS = 30_000;
/** Windows listed in one result (the rest are announced, never dropped
 * silently). */
export const MAX_WINDOW_LINES = 100;
/** Largest region a screenshot may ask for, per side. */
export const MAX_CAPTURE_DIMENSION = 16384;

/** What the last screenshot covered, in screen pixels, plus the scale of
 * the image the model saw. */
interface CaptureView {
  screen: Rect;
  scale: number;
}

/** The per-session state the tools share: which image the agent's
 * coordinates currently refer to. Each session gets its own tool instances
 * (the pool seeds them per registry), so this is per session by
 * construction. */
interface ComputerToolState {
  view?: CaptureView;
}

export interface ComputerToolsOptions {
  /** The host to drive, or undefined when this session has none (no host on
   * this platform, or the feature is disabled). Resolved at execute time. */
  resolveHost: () => ComputerHost | undefined;
}

/** Build the computer-use tool family. */
export function createComputerTools(options: ComputerToolsOptions): Tool[] {
  const state: ComputerToolState = {};
  return [
    createScreenshotTool(options, state),
    createActTool(options, state),
    createListWindowsTool(options),
  ];
}

/** Resolve the host or fail with the reason an agent can act on. */
function requireHost(
  resolveHost: () => ComputerHost | undefined,
): ComputerHost {
  const host = resolveHost();
  if (host === undefined) {
    throw new CoreError(
      "computer use is not available in this session: the server has no " +
        "computer host attached, or the feature is disabled in settings " +
        "(Settings -> security -> computer use)",
      "unavailable",
    );
  }
  return host;
}

function requireInteger(value: number | undefined, name: string): number {
  if (value === undefined || !Number.isInteger(value)) {
    throw new CoreError(`${name} must be an integer (got ${value})`, "invalid");
  }
  return value;
}

function requireView(state: ComputerToolState): CaptureView {
  if (state.view === undefined) {
    throw new CoreError(
      "no screenshot yet: computer_act coordinates are the pixels of the " +
        "most recent computer_screenshot, so take one first",
      "invalid",
    );
  }
  return state.view;
}

/** Image pixels of the last screenshot → screen pixels. */
function toScreen(view: CaptureView, point: Point): Point {
  return {
    x: Math.round(point.x / view.scale) + view.screen.x,
    y: Math.round(point.y / view.scale) + view.screen.y,
  };
}

/** `image (640, 360) → screen (1280, 720)` — the mapping, spelled out. */
function describeMapping(image: Point, screen: Point): string {
  return `image (${image.x}, ${image.y}) → screen (${screen.x}, ${screen.y})`;
}

function describeCursor(cursor: Point): string {
  return `Cursor now at screen (${cursor.x}, ${cursor.y}).`;
}

function describeWindow(window: WindowInfo): string {
  const size = `${window.bounds.width}×${window.bounds.height} at ` +
    `(${window.bounds.x}, ${window.bounds.y})`;
  const flags = [
    window.focused ? "focused" : "",
    window.minimized ? "minimized" : "",
  ].filter((flag) => flag.length > 0);
  return `${window.id} "${window.title}" ${size}${
    flags.length > 0 ? ` ${flags.join(" ")}` : ""
  }`;
}

/** One display, e.g. `0 (primary) 2560×1440 at (0, 0)`. */
function describeDisplay(display: DisplayInfo): string {
  return `${display.index}${display.primary ? " (primary)" : ""} ` +
    `${display.bounds.width}×${display.bounds.height} at ` +
    `(${display.bounds.x}, ${display.bounds.y})`;
}

/** The mapping line every screenshot ends with: the exact arithmetic the
 * agent would otherwise have to guess. */
function describeView(view: CaptureView): string {
  return `computer_act coordinates are pixels of THIS image: screen = ` +
    `round(image / ${view.scale.toFixed(3)}) + (${view.screen.x}, ` +
    `${view.screen.y}).`;
}

// --- computer_screenshot ----------------------------------------------------

const screenshotSchema = object({
  display: optional(integer(
    "0-based display index (default: the primary display). Ignored when " +
      "region is given.",
  )),
  region: optional(object({
    x: integer(
      "Left edge in screen pixels (virtual-desktop coordinates; " +
        "may be negative on a monitor left of the primary one)",
    ),
    y: integer("Top edge in screen pixels"),
    width: integer(`Width in pixels (1..${MAX_CAPTURE_DIMENSION})`),
    height: integer(`Height in pixels (1..${MAX_CAPTURE_DIMENSION})`),
  }, {
    description:
      "Explicit screen region to capture instead of a whole display " +
      "(absolute virtual-desktop coordinates, so it can span monitors). " +
      "Use it to zoom into a small area: a region smaller than " +
      "max_dimension is returned 1:1.",
  })),
  max_dimension: optional(integer(
    `Longest side of the returned image in pixels (${MIN_MAX_DIMENSION}..` +
      `${MAX_MAX_DIMENSION}, default ${DEFAULT_MAX_DIMENSION}). The image is ` +
      "never upscaled. Smaller images are cheaper but harder to read.",
  )),
});

function createScreenshotTool(
  options: ComputerToolsOptions,
  state: ComputerToolState,
): Tool<typeof screenshotSchema> {
  return {
    name: TOOL_COMPUTER_SCREENSHOT,
    label: "Computer Screenshot",
    description:
      "Capture this machine's screen as an image the model can see. " +
      "Captures a whole display by default (display index, default: the " +
      "primary) or an explicit region in screen pixels. The image is scaled " +
      "to fit max_dimension and the result states the exact mapping between " +
      "image pixels and screen pixels; computer_act then takes coordinates " +
      "in THAT image's pixels. Take a fresh screenshot after the screen " +
      "changed. The machine is the one the server runs on.",
    parameters: screenshotSchema,
    execute: async (_id, params): Promise<ToolResult> => {
      const host = requireHost(options.resolveHost);
      const maxDimension = params.max_dimension ?? DEFAULT_MAX_DIMENSION;
      if (
        !Number.isInteger(maxDimension) || maxDimension < MIN_MAX_DIMENSION ||
        maxDimension > MAX_MAX_DIMENSION
      ) {
        throw new CoreError(
          `max_dimension must be an integer ${MIN_MAX_DIMENSION}..` +
            `${MAX_MAX_DIMENSION} (got ${params.max_dimension})`,
          "invalid",
        );
      }
      const displays = host.displays();
      const { region, display } = resolveCaptureRegion(params, displays);
      const raw = await host.capture(region);
      const encoded = encodeCapture(raw, maxDimension);
      const view: CaptureView = { screen: raw.screen, scale: encoded.scale };
      state.view = view;
      const cursor = host.cursor();

      const header = display === undefined
        ? `region ${region.width}×${region.height} at screen ` +
          `(${region.x}, ${region.y})`
        : `display ${display.index}${
          display.primary ? " (primary)" : ""
        }: screen ${region.width}×${region.height} at ` +
          `(${region.x}, ${region.y})`;
      const text = [
        `${header}; image ${encoded.width}×${encoded.height} ` +
        `(scale ${encoded.scale.toFixed(3)}). Cursor at screen ` +
        `(${cursor.x}, ${cursor.y}).`,
        `Displays: ${
          displays.map((entry) =>
            describeDisplay(entry) +
            (display !== undefined && entry.index === display.index
              ? " ← captured"
              : "")
          ).join(" | ")
        }`,
        describeView(view),
      ].join("\n");

      return {
        content: [
          { type: "text", text },
          {
            type: "image",
            data: bytesToBase64(encoded.png),
            mimeType: "image/png",
          },
        ],
        details: {
          ...(display !== undefined ? { display: display.index } : {}),
          screen: region,
          image: { width: encoded.width, height: encoded.height },
          scale: encoded.scale,
          cursor,
          bytes: encoded.png.length,
        },
      };
    },
  };
}

/** Resolve what to capture: an explicit region, or one display's bounds. */
function resolveCaptureRegion(
  params: { display?: number; region?: Rect },
  displays: DisplayInfo[],
): { region: Rect; display?: DisplayInfo } {
  if (params.region !== undefined) {
    const region = params.region;
    for (
      const [name, value] of [
        ["region.x", region.x],
        ["region.y", region.y],
        ["region.width", region.width],
        ["region.height", region.height],
      ] as const
    ) {
      requireInteger(value, name);
    }
    if (
      region.width < 1 || region.height < 1 ||
      region.width > MAX_CAPTURE_DIMENSION ||
      region.height > MAX_CAPTURE_DIMENSION
    ) {
      throw new CoreError(
        `region size ${region.width}×${region.height} is out of range ` +
          `(1..${MAX_CAPTURE_DIMENSION} per side)`,
        "invalid",
      );
    }
    const covered = displays.find((entry) => intersects(entry.bounds, region));
    if (covered === undefined) {
      throw new CoreError(
        `region (${region.x}, ${region.y}) ${region.width}×${region.height} ` +
          `does not overlap any display (${
            displays.map(describeDisplay).join(" | ")
          })`,
        "invalid",
      );
    }
    return { region };
  }
  const index = params.display ??
    displays.findIndex((entry) => entry.primary);
  const display = displays[index];
  if (display === undefined) {
    throw new CoreError(
      `unknown display index ${index} (this machine has ${displays.length} ` +
        `display(s): ${displays.map((entry) => entry.index).join(", ")})`,
      "invalid",
    );
  }
  return { region: display.bounds, display };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height;
}

// --- computer_act -----------------------------------------------------------

const actSchema = object({
  action: string(
    'The action: "move" | "click" | "drag" | "scroll" | "type" | "key" | ' +
      '"focus_window" | "wait". Mouse actions take x/y in the pixels of the ' +
      "most recent computer_screenshot; movement is interpolated over about " +
      "0.1s (0.3s for a drag) so hover state and drag targets react like " +
      "they would to a real hand.",
  ),
  x: optional(integer(
    "Target x in the last screenshot's image pixels (move / click / drag " +
      "start / scroll position)",
  )),
  y: optional(integer("Target y in the last screenshot's image pixels")),
  to_x: optional(integer("Drag end x in image pixels (drag only)")),
  to_y: optional(integer("Drag end y in image pixels (drag only)")),
  button: optional(string(
    '"left" (default) | "right" | "middle"',
  )),
  count: optional(integer(
    "Click count: 1 (default) or 2 (double click)",
  )),
  delta_x: optional(integer(
    "Horizontal scroll in wheel notches, positive = right (scroll only)",
  )),
  delta_y: optional(integer(
    "Vertical scroll in wheel notches, positive = down (scroll only)",
  )),
  text: optional(string(
    `Text to type at the current focus, sent as Unicode (any language). ` +
      `Newlines are typed as Enter presses (a newline character on its own ` +
      `is ignored by most controls). At most ${MAX_TYPE_CHARS} characters ` +
      `per call; for long text the clipboard path is more reliable (see the ` +
      `computer-use skill).`,
  )),
  key: optional(string(
    'Key or chord to press: "enter", "escape", "tab", "f5", "a", ' +
      '"ctrl+shift+s", "win+left". A single character is pressed as the key ' +
      'that produces it on the current keyboard layout (so "A" presses ' +
      "Shift implicitly).",
  )),
  window: optional(string(
    "Window id from computer_list_windows, e.g. 0x000A0B2C (focus_window " +
      "only)",
  )),
  duration_ms: optional(integer(
    `Milliseconds to wait (wait only, at most ${MAX_WAIT_MS})`,
  )),
});

function createActTool(
  options: ComputerToolsOptions,
  state: ComputerToolState,
): Tool<typeof actSchema> {
  return {
    name: TOOL_COMPUTER_ACT,
    label: "Computer Act",
    description:
      "Act on this machine with the real mouse and keyboard: move, click " +
      "(count 2 = double click), drag (press, move, release), scroll, type " +
      "text, press a key or chord, bring a window to the foreground, or " +
      "wait. Coordinates are the image pixels of the most recent " +
      "computer_screenshot (take one first); the result reports the screen " +
      "coordinates they resolved to. Mouse movement is interpolated over " +
      "about 0.1s, and a drag holds the button down while it travels, so " +
      "hover-revealed UI and drop targets behave as with a real hand. " +
      "Typing goes to whatever holds the focus — check it with " +
      "computer_list_windows or focus a window first.",
    parameters: actSchema,
    execute: async (_id, params): Promise<ToolResult> => {
      const host = requireHost(options.resolveHost);
      const built = buildAction(params, state);
      const result = await host.act(built.action);
      const lines = [summarizeAction(built.action, result)];
      if (built.mapping !== undefined) lines.push(built.mapping);
      if (result.window !== undefined) {
        lines.push(`Focused window: ${describeWindow(result.window)}.`);
      }
      if (isMouseAction(built.action)) {
        lines.push(describeCursor(result.cursor));
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          action: params.action,
          ...(built.imagePoint !== undefined
            ? { image: built.imagePoint }
            : {}),
          ...(built.screenPoint !== undefined
            ? { screen: built.screenPoint }
            : {}),
          cursor: result.cursor,
          steps: result.steps,
          durationMs: result.durationMs,
          ...(result.window !== undefined
            ? { window: result.window.id, windowTitle: result.window.title }
            : {}),
        },
      };
    },
  };
}

function isMouseAction(action: ComputerAction): boolean {
  return action.kind === "move" || action.kind === "click" ||
    action.kind === "drag" || action.kind === "scroll";
}

/** What the action did, with the resolved coordinates and the measured
 * timing (the agent can compare them against what it intended). */
function summarizeAction(
  action: ComputerAction,
  result: ComputerActionResult,
): string {
  const moved = result.steps > 0
    ? ` in ${result.steps} steps (${result.durationMs}ms)`
    : "";
  switch (action.kind) {
    case "move":
      return `moved to screen (${action.x}, ${action.y})${moved}.`;
    case "click":
      return `clicked ${action.button}${
        action.count === 2 ? " twice" : ""
      } at screen (${action.x}, ${action.y})${moved}.`;
    case "drag":
      return `dragged ${action.button} from screen (${action.from.x}, ` +
        `${action.from.y}) to screen (${action.to.x}, ${action.to.y})${moved}.`;
    case "scroll":
      return `scrolled (${action.deltaX}, ${action.deltaY}) at screen ` +
        `(${action.x}, ${action.y})${moved}.`;
    case "type":
      return `typed ${action.text.length} character(s).`;
    case "key":
      return `pressed ${action.key}.`;
    case "focus_window":
      return `focused window ${action.window}.`;
    case "wait":
      return `waited ${action.durationMs}ms.`;
  }
}

/** A built action plus the text that explains how its coordinates resolved. */
interface BuiltAction {
  action: ComputerAction;
  /** `image (…) → screen (…)` when the action used image coordinates. */
  mapping?: string;
  imagePoint?: Point;
  screenPoint?: Point;
}

/** Turn validated arguments into a host action, converting image
 * coordinates through the recorded view. */
function buildAction(
  params: {
    action: string;
    x?: number;
    y?: number;
    to_x?: number;
    to_y?: number;
    button?: string;
    count?: number;
    delta_x?: number;
    delta_y?: number;
    text?: string;
    key?: string;
    window?: string;
    duration_ms?: number;
  },
  state: ComputerToolState,
): BuiltAction {
  const button = parseButton(params.button);
  // Argument checks run before the view is required: a bad coordinate is a
  // clearer complaint than "no screenshot yet", and it does not depend on
  // state at all.
  const point = (): { image: Point; screen: Point } => {
    const image = {
      x: requireInteger(params.x, "x"),
      y: requireInteger(params.y, "y"),
    };
    const view = requireView(state);
    return { image, screen: toScreen(view, image) };
  };
  switch (params.action) {
    case "move": {
      const { image, screen } = point();
      return {
        action: { kind: "move", x: screen.x, y: screen.y },
        mapping: describeMapping(image, screen),
        imagePoint: image,
        screenPoint: screen,
      };
    }
    case "click": {
      const count = params.count ?? 1;
      if (count !== 1 && count !== 2) {
        throw new CoreError(
          `count must be 1 or 2 (got ${params.count})`,
          "invalid",
        );
      }
      const { image, screen } = point();
      return {
        action: { kind: "click", x: screen.x, y: screen.y, button, count },
        mapping: describeMapping(image, screen),
        imagePoint: image,
        screenPoint: screen,
      };
    }
    case "drag": {
      const from = {
        x: requireInteger(params.x, "x"),
        y: requireInteger(params.y, "y"),
      };
      const to = {
        x: requireInteger(params.to_x, "to_x"),
        y: requireInteger(params.to_y, "to_y"),
      };
      const view = requireView(state);
      const fromScreen = toScreen(view, from);
      const toScreenPoint = toScreen(view, to);
      return {
        action: {
          kind: "drag",
          from: fromScreen,
          to: toScreenPoint,
          button,
        },
        mapping: `from ${describeMapping(from, fromScreen)} to ` +
          `image (${to.x}, ${to.y}) → screen (${toScreenPoint.x}, ` +
          `${toScreenPoint.y})`,
        imagePoint: from,
        screenPoint: fromScreen,
      };
    }
    case "scroll": {
      const deltaX = params.delta_x ?? 0;
      const deltaY = params.delta_y ?? 0;
      requireInteger(deltaX, "delta_x");
      requireInteger(deltaY, "delta_y");
      if (deltaX === 0 && deltaY === 0) {
        throw new CoreError(
          "scroll needs delta_x and/or delta_y",
          "invalid",
        );
      }
      const { image, screen } = point();
      return {
        action: { kind: "scroll", x: screen.x, y: screen.y, deltaX, deltaY },
        mapping: describeMapping(image, screen),
        imagePoint: image,
        screenPoint: screen,
      };
    }
    case "type": {
      const text = params.text;
      if (text === undefined || text.length === 0) {
        throw new CoreError("type needs a non-empty text", "invalid");
      }
      if (text.length > MAX_TYPE_CHARS) {
        throw new CoreError(
          `text is too long (${text.length} characters; at most ` +
            `${MAX_TYPE_CHARS} per call)`,
          "invalid",
        );
      }
      return { action: { kind: "type", text } };
    }
    case "key": {
      const key = params.key;
      if (key === undefined || key.trim().length === 0) {
        throw new CoreError("key needs a key name or chord", "invalid");
      }
      return { action: { kind: "key", key } };
    }
    case "focus_window": {
      const window = params.window;
      if (window === undefined || window.trim().length === 0) {
        throw new CoreError(
          "focus_window needs a window id from computer_list_windows",
          "invalid",
        );
      }
      return { action: { kind: "focus_window", window } };
    }
    case "wait": {
      const durationMs = requireInteger(params.duration_ms, "duration_ms");
      if (durationMs < 0 || durationMs > MAX_WAIT_MS) {
        throw new CoreError(
          `duration_ms must be 0..${MAX_WAIT_MS} (got ${params.duration_ms})`,
          "invalid",
        );
      }
      return { action: { kind: "wait", durationMs } };
    }
    default:
      throw new CoreError(
        `unknown action "${params.action}" (move / click / drag / scroll / ` +
          "type / key / focus_window / wait)",
        "invalid",
      );
  }
}

function parseButton(button: string | undefined): MouseButton {
  if (button === undefined) return "left";
  if (button === "left" || button === "right" || button === "middle") {
    return button;
  }
  throw new CoreError(
    `unknown button "${button}" (left / right / middle)`,
    "invalid",
  );
}

// --- computer_list_windows --------------------------------------------------

const listWindowsSchema = object({
  title_contains: optional(string(
    "Only list windows whose title contains this text " +
      "(case-insensitive). Omit to list every window.",
  )),
});

function createListWindowsTool(
  options: ComputerToolsOptions,
): Tool<typeof listWindowsSchema> {
  return {
    name: TOOL_COMPUTER_LIST_WINDOWS,
    label: "Computer List Windows",
    description:
      "List this machine's top-level windows in z-order (topmost first) " +
      "with their id, title, screen rectangle and state. Use it to find the " +
      "window to focus before typing, to see which display a window is on, " +
      "or to check what is currently in the foreground. Windows without a " +
      "title are not listed.",
    parameters: listWindowsSchema,
    execute: (_id, params): Promise<ToolResult> => {
      const host = requireHost(options.resolveHost);
      const all = host.windows();
      const filter = params.title_contains?.toLowerCase();
      const matches = filter === undefined
        ? all
        : all.filter((window) => window.title.toLowerCase().includes(filter));
      if (matches.length === 0) {
        const text = filter === undefined
          ? "No windows are open."
          : `No window title contains "${params.title_contains}" (${all.length} window(s) open).`;
        return Promise.resolve({
          content: [{ type: "text", text }],
          details: { windows: 0, total: all.length },
        });
      }
      const listed = matches.slice(0, MAX_WINDOW_LINES);
      const hidden = matches.length - listed.length;
      const lines = [
        `${matches.length} window(s), z-order (topmost first):`,
        ...listed.map(describeWindow),
      ];
      if (hidden > 0) {
        lines.push(
          `… (+${hidden} more; narrow the list with title_contains)`,
        );
      }
      return Promise.resolve({
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          windows: matches.length,
          total: all.length,
          ...(filter !== undefined
            ? { filter: params.title_contains ?? "" }
            : {}),
        },
      });
    },
  };
}
