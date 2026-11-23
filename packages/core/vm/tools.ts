/**
 * The stella machine's screen tools: `vm_screenshot` and `vm_act`.
 *
 * The agent reads a position off the screenshot and hands it back to be
 * clicked, so this layer's whole job is to keep those two spaces identical.
 * The machine's screen is a fixed 1280x800 and a capture is never resized: an
 * image pixel IS a screen pixel, so a coordinate the model read is the
 * coordinate an input event reaches. A position outside the screen fails
 * loudly rather than being clamped — a silently moved click is a wrong
 * action, not a corrected one.
 *
 * A screenshot may cover a region instead of the whole screen. The region is
 * returned 1:1, which is how small text becomes readable without opening
 * another application; the result states the region's origin so a position
 * read off the crop still becomes the screen pixel `vm_act` takes.
 *
 * `vm_act` takes an array of actions and returns a screenshot after the last
 * one (unless `observe: false`). A batch saves a model round trip per action,
 * and the observation saves the separate `vm_screenshot` that used to follow
 * every action. A failed action stops the batch and still gets the picture,
 * so the next decision is made from what the screen actually shows.
 */
import { bytesToBase64 } from "../base64.ts";
import { CoreError, errorMessage } from "../errors.ts";
import { prepareStoredImage } from "../media/stored-image.ts";
import {
  array,
  boolean,
  integer,
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "../ports/tool.ts";
import {
  requireInteger,
  requireIntegerInRange,
  requireOneOf,
} from "../ports/validate.ts";
import {
  abortError,
  sleepAbortable,
  TOOL_VM_ACT,
  TOOL_VM_SCREENSHOT,
} from "../shared/mod.ts";

/** A required integer argument: the schema marks it optional (the action
 * decides which coordinates apply), so the message names the action. */
function requireCoord(name: string, value: number | undefined): number {
  if (value === undefined) {
    throw new CoreError(`${name} is required for this action`, "invalid");
  }
  return requireInteger(name, value);
}

import {
  VM_SCREEN_HEIGHT,
  VM_SCREEN_WIDTH,
  VM_SCROLL_NOTCH,
} from "./contract.ts";
import type { VmScreen, VmScreenRegion } from "./screen.ts";

/** One action may wait at most this long (a deliberate pause for a page to
 * paint). */
const MAX_WAIT_MS = 10_000;

/** One call may carry this many actions. Enough for a form filled in one
 * step, small enough that a stray long array cannot hold the run. */
const MAX_ACTIONS = 20;

const screenshotSchema = object({
  region: optional(
    object(
      {
        x: integer("Left edge in screen pixels"),
        y: integer("Top edge in screen pixels"),
        width: integer(
          `Width in pixels (1..${VM_SCREEN_WIDTH}). A region is returned 1:1.`,
        ),
        height: integer(
          `Height in pixels (1..${VM_SCREEN_HEIGHT}). A region is returned 1:1.`,
        ),
      },
      {
        description:
          "Screen region to capture instead of the whole screen. Use it to " +
          "read small text or a dense control without opening another view.",
      },
    ),
  ),
});

const actionSchema = object({
  action: string(
    'The action: "move" | "click" | "drag" | "scroll" | "type" | "key" | ' +
      '"wait". Mouse actions take x/y in screen pixels ' +
      `(${VM_SCREEN_WIDTH}x${VM_SCREEN_HEIGHT}); a vm_screenshot may be ` +
      "scaled or cropped, so convert a position read off it by the factor " +
      "and origin that result states.",
  ),
  x: optional(integer("Target x in screen pixels (move / click / scroll)")),
  y: optional(integer("Target y in screen pixels (move / click / scroll)")),
  to_x: optional(integer("Drag end x in screen pixels (drag only)")),
  to_y: optional(integer("Drag end y in screen pixels (drag only)")),
  button: optional(string('Mouse button: "left" (default), "right", "middle"')),
  count: optional(
    integer(
      "Clicks to perform: 1 (default), 2 (double-click), 3 (triple-click)",
    ),
  ),
  text: optional(string("Text to type (type only)")),
  key: optional(
    string(
      "Key or key combination by xdotool name, e.g. `Return`, `Escape`, " +
        "`Tab`, `ctrl+a`, `super` (key only)",
    ),
  ),
  vertical: optional(
    integer(
      `Scroll amount in wheel notches (${VM_SCROLL_NOTCH} per notch, at most ` +
        "20 notches): positive scrolls down, negative up (scroll only)",
    ),
  ),
  horizontal: optional(
    integer(
      `Scroll amount in wheel notches (${VM_SCROLL_NOTCH} per notch, at most ` +
        "20 notches): positive scrolls right, negative left (scroll only)",
    ),
  ),
  duration_ms: optional(
    integer(`Milliseconds to wait (wait only, at most ${MAX_WAIT_MS})`),
  ),
});

const actSchema = object({
  actions: array(
    actionSchema,
    `Actions to run in order (1..${MAX_ACTIONS}). A failed action stops the ` +
      "batch. Each action uses the same fields as before; only the array " +
      "wraps them.",
  ),
  observe: optional(
    boolean(
      "Return a screenshot after the last action (default true). It covers " +
        "the same region as the last vm_screenshot, or the whole screen when " +
        "there is none. Set false when the next step does not depend on the " +
        "screen; the next coordinate action must then take a screenshot first.",
    ),
  ),
});

export interface VmToolsOptions {
  screen: VmScreen;
}

/** The one piece of state the two tools share: the region the last
 * screenshot covered, so a post-action observation can show the same crop. */
interface VmToolsState {
  lastRegion?: VmScreenRegion;
}

/** Build the screen tool set of a stella session. */
export function createVmTools(options: VmToolsOptions): Tool[] {
  const state: VmToolsState = {};
  return [createScreenshotTool(options, state), createActTool(options, state)];
}

/** The picture against the space it shows. A copy the store scaled down is
 * still a map of the same screen, so the text carries the factor and the
 * crop's origin: the model reads positions off the picture, and `vm_act`
 * takes screen pixels. */
function describeScreenshot(
  width: number,
  height: number,
  region: VmScreenRegion | undefined,
): string {
  const area = region ?? {
    x: 0,
    y: 0,
    width: VM_SCREEN_WIDTH,
    height: VM_SCREEN_HEIGHT,
  };
  const screen = `The screen is ${VM_SCREEN_WIDTH}x${VM_SCREEN_HEIGHT} pixels`;
  const coverage =
    region === undefined
      ? "this image covers the whole screen"
      : `this image covers the screen region ${region.width}x${region.height} at (${region.x}, ${region.y})`;
  const offset =
    area.x === 0 && area.y === 0 ? "" : ` after adding (${area.x}, ${area.y})`;
  if (width === area.width && height === area.height) {
    return `${screen}; ${coverage} at 1:1, so a position read off the image is a screen pixel${offset}.`;
  }
  const factor = area.width / width;
  return `${screen}; ${coverage} and is ${width}x${height}, so multiply a position read off the image by ${factor.toFixed(3)}${offset} to get the screen pixel vm_act takes.`;
}

interface ScreenshotResult {
  text: string;
  image: { type: "image"; data: string; mimeType: string };
  details: Record<string, unknown>;
}

/** Capture one view and turn it into the picture plus the text that maps it
 * back to screen pixels. Both tools use this, so a post-action observation
 * and an explicit screenshot describe the same space. */
async function takeScreenshot(
  screen: VmScreen,
  state: VmToolsState,
  region: VmScreenRegion | undefined,
  signal: AbortSignal | undefined,
): Promise<ScreenshotResult> {
  const png = await screen.screenshot(region, signal);
  // The transcript keeps a bounded copy (see media/stored-image.ts). A
  // smaller copy is still a picture of the same view — the aspect ratio is
  // kept, and the text below is what turns a position read off it into the
  // screen pixel vm_act takes.
  const stored = await prepareStoredImage(png, "image/png");
  const sourceWidth = region?.width ?? VM_SCREEN_WIDTH;
  const sourceHeight = region?.height ?? VM_SCREEN_HEIGHT;
  const width = stored.size?.width ?? sourceWidth;
  const height = stored.size?.height ?? sourceHeight;
  state.lastRegion = region;
  return {
    text: describeScreenshot(width, height, region),
    image: {
      type: "image",
      data: bytesToBase64(stored.bytes),
      mimeType: stored.mimeType,
    },
    details: {
      screen: { width: VM_SCREEN_WIDTH, height: VM_SCREEN_HEIGHT },
      ...(region !== undefined ? { region } : {}),
      image: { width, height },
      bytes: stored.bytes.byteLength,
    },
  };
}

function createScreenshotTool(
  { screen }: VmToolsOptions,
  state: VmToolsState,
): Tool<typeof screenshotSchema> {
  return {
    name: TOOL_VM_SCREENSHOT,
    label: "VM Screenshot",
    description:
      `Take a screenshot of the machine's screen, or one region of it, and ` +
      `return it as an image (${VM_SCREEN_WIDTH}x${VM_SCREEN_HEIGHT} for the ` +
      "whole screen). The mouse pointer is drawn in the image, so its " +
      "position and what is under it are visible. Passing a region returns a " +
      "1:1 crop, which is the way to read small text or a dense control; the " +
      "result states the crop's origin and any scale, so a position read off " +
      "it becomes the screen pixel vm_act takes. Use observe on vm_act when " +
      "the screenshot is only there to see an action's result.",
    parameters: screenshotSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const shot = await takeScreenshot(screen, state, params.region, signal);
      return {
        content: [{ type: "text", text: shot.text }, shot.image],
        details: shot.details,
      };
    },
  };
}

function createActTool(
  { screen }: VmToolsOptions,
  state: VmToolsState,
): Tool<typeof actSchema> {
  return {
    name: TOOL_VM_ACT,
    label: "VM Act",
    description:
      `Operate the machine's screen: move the pointer, click, drag, scroll, ` +
      "type text, press a key, or wait for the screen to settle. Send one or " +
      `more actions in order (at most ${MAX_ACTIONS}); a failed action stops ` +
      "the batch. Positions are screen pixels " +
      `(${VM_SCREEN_WIDTH}x${VM_SCREEN_HEIGHT}); a position read off a ` +
      "scaled or cropped vm_screenshot is converted with the factor and " +
      "origin that result states. Unless observe is false, the result " +
      "includes a screenshot after the last action covering the same region " +
      "as the last vm_screenshot, so a separate vm_screenshot is usually " +
      "not needed.",
    parameters: actSchema,
    async execute(_id, params, signal): Promise<ToolResult> {
      const actions = params.actions;
      if (actions.length === 0) {
        throw new CoreError(
          "actions must contain at least one action",
          "invalid",
        );
      }
      if (actions.length > MAX_ACTIONS) {
        throw new CoreError(
          `too many actions (${actions.length}; at most ${MAX_ACTIONS} per call)`,
          "invalid",
        );
      }
      const lines: string[] = [];
      const details: Record<string, unknown>[] = [];
      let failure: { index: number; error: unknown } | undefined;
      for (let index = 0; index < actions.length; index += 1) {
        if (signal?.aborted === true) throw abortError();
        const action = actions[index]!;
        try {
          const done = await runAction(screen, action, signal);
          lines.push(
            actions.length === 1 ? done.text : `${index + 1}. ${done.text}`,
          );
          details.push({ action: action.action, ...done.details });
        } catch (error) {
          if (signal?.aborted) throw error;
          failure = { index, error };
          const message = `failed: ${errorMessage(error)}`;
          lines.push(
            actions.length === 1 ? message : `${index + 1}. ${message}`,
          );
          break;
        }
      }
      if (failure !== undefined) {
        lines.push(
          `Stopped after ${failure.index} of ${actions.length} action(s).`,
        );
      }
      const resultDetails: Record<string, unknown> = {
        actions: details,
        completed: failure?.index ?? actions.length,
        ...(failure !== undefined
          ? { failed: true, error: errorMessage(failure.error) }
          : {}),
      };
      if (params.observe === false) {
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { ...resultDetails, observe: false },
        };
      }
      try {
        const shot = await takeScreenshot(
          screen,
          state,
          state.lastRegion,
          signal,
        );
        lines.push(shot.text);
        return {
          content: [{ type: "text", text: lines.join("\n") }, shot.image],
          details: { ...resultDetails, ...shot.details },
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        // The actions may have happened even when the capture failed; keep
        // their result instead of replacing it with the capture failure.
        const message = `The screen could not be captured after the actions: ${errorMessage(error)}`;
        lines.push(message);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { ...resultDetails, captureError: errorMessage(error) },
        };
      }
    },
  };
}

/** The validated fields one action carries. */
type VmActionParams = {
  action: string;
  x?: number;
  y?: number;
  to_x?: number;
  to_y?: number;
  button?: string;
  count?: number;
  text?: string;
  key?: string;
  vertical?: number;
  horizontal?: number;
  duration_ms?: number;
};

/** Run one action and describe it. Throws on a bad argument or a failed
 * input event; the caller stops the batch and keeps the message. */
async function runAction(
  screen: VmScreen,
  params: VmActionParams,
  signal: AbortSignal | undefined,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const action = params.action.trim();
  switch (action) {
    case "move": {
      const x = requireCoord("x", params.x);
      const y = requireCoord("y", params.y);
      await screen.move(x, y, signal);
      return actionResult(`moved to (${x}, ${y}).`, { x, y });
    }
    case "click": {
      const x = requireCoord("x", params.x);
      const y = requireCoord("y", params.y);
      const button = requireOneOf("button", params.button ?? "left", [
        "left",
        "right",
        "middle",
      ] as const);
      const count = requireIntegerInRange("count", params.count ?? 1, 1, 3);
      await screen.click(x, y, { button, count }, signal);
      return actionResult(
        `clicked ${button}${count > 1 ? ` ${count} times` : ""} at ` +
          `(${x}, ${y}).`,
        { x, y, button, count },
      );
    }
    case "drag": {
      const x = requireCoord("x", params.x);
      const y = requireCoord("y", params.y);
      const toX = requireCoord("to_x", params.to_x);
      const toY = requireCoord("to_y", params.to_y);
      const button = requireOneOf("button", params.button ?? "left", [
        "left",
        "right",
        "middle",
      ] as const);
      await screen.drag(x, y, toX, toY, button, signal);
      return actionResult(
        `dragged ${button} from (${x}, ${y}) to (${toX}, ${toY}).`,
        { from: { x, y }, to: { x: toX, y: toY }, button },
      );
    }
    case "scroll": {
      const x = requireCoord("x", params.x);
      const y = requireCoord("y", params.y);
      const vertical = requireInteger("vertical", params.vertical ?? 0);
      const horizontal = requireInteger("horizontal", params.horizontal ?? 0);
      if (vertical === 0 && horizontal === 0) {
        throw new CoreError(
          "scroll needs a vertical or horizontal amount",
          "invalid",
        );
      }
      await screen.scroll(x, y, { vertical, horizontal }, signal);
      return actionResult(
        `scrolled ${vertical === 0 ? "" : `${vertical} vertically`}` +
          `${vertical !== 0 && horizontal !== 0 ? " and " : ""}` +
          `${horizontal === 0 ? "" : `${horizontal} horizontally`} at ` +
          `(${x}, ${y}).`,
        { x, y, vertical, horizontal },
      );
    }
    case "type": {
      const text = params.text;
      if (text === undefined || text.length === 0) {
        throw new CoreError("type needs `text`", "invalid");
      }
      await screen.type(text, signal);
      return actionResult(`typed ${text.length} character(s).`, {
        characters: text.length,
      });
    }
    case "key": {
      const key = params.key;
      if (key === undefined || key.trim().length === 0) {
        throw new CoreError(
          "key needs a key name (e.g. `Return`, `ctrl+a`)",
          "invalid",
        );
      }
      await screen.key(key, signal);
      return actionResult(`pressed ${key}.`, { key });
    }
    case "wait": {
      const durationMs = requireIntegerInRange(
        "duration_ms",
        params.duration_ms ?? 1000,
        1,
        MAX_WAIT_MS,
      );
      await sleepAbortable(durationMs, signal, abortError);
      return actionResult(`waited ${durationMs}ms.`, { durationMs });
    }
    default:
      throw new CoreError(
        `Unknown action "${params.action}". Use move, click, drag, ` +
          "scroll, type, key or wait.",
        "invalid",
      );
  }
}

/** One action's sentence plus the resolved arguments, so a mis-click is
 * diagnosable from the transcript alone. */
function actionResult(
  text: string,
  details: Record<string, unknown>,
): { text: string; details: Record<string, unknown> } {
  return { text, details };
}
