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
 * The tools are preloaded (not discovered through tool_search): the machine's
 * screen is the one surface that makes GUI work possible at all, and an agent
 * that does not know it can look would never try.
 */
import { bytesToBase64 } from "../base64.ts";
import { CoreError } from "../errors.ts";
import {
  abortError,
  sleepAbortable,
  TOOL_VM_ACT,
  TOOL_VM_SCREENSHOT,
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
  requireInteger,
  requireIntegerInRange,
  requireOneOf,
} from "../tools/validate.ts";

/** A required integer argument: the schema marks it optional (the action
 * decides which coordinates apply), so the message names the action. */
function requireCoord(name: string, value: number | undefined): number {
  if (value === undefined) {
    throw new CoreError(`${name} is required for this action`, "invalid");
  }
  return requireInteger(name, value);
}
import { VM_SCREEN_HEIGHT, VM_SCREEN_WIDTH } from "./contract.ts";
import type { VmScreen } from "./screen.ts";

/** One action may wait at most this long (a deliberate pause for a page to
 * paint). */
const MAX_WAIT_MS = 10_000;

const screenshotSchema = object({});

const actSchema = object({
  action: string(
    'The action: "move" | "click" | "drag" | "scroll" | "type" | "key" | ' +
      '"wait". Mouse actions take x/y in the pixels of the most recent ' +
      "vm_screenshot (the image is 1:1 with the screen, so a position read " +
      "off it is used as-is).",
  ),
  x: optional(integer("Target x in screen pixels (move / click / scroll)")),
  y: optional(integer("Target y in screen pixels (move / click / scroll)")),
  to_x: optional(integer("Drag end x in screen pixels (drag only)")),
  to_y: optional(integer("Drag end y in screen pixels (drag only)")),
  button: optional(string('Mouse button: "left" (default), "right", "middle"')),
  count: optional(integer(
    "Clicks to perform: 1 (default), 2 (double-click), 3 (triple-click)",
  )),
  text: optional(string("Text to type (type only)")),
  key: optional(string(
    "Key or key combination by xdotool name, e.g. `Return`, `Escape`, " +
      "`Tab`, `ctrl+a`, `super` (key only)",
  )),
  vertical: optional(integer(
    "Scroll amount: positive scrolls down, negative up (scroll only)",
  )),
  horizontal: optional(integer(
    "Scroll amount: positive scrolls right, negative left (scroll only)",
  )),
  duration_ms: optional(integer(
    `Milliseconds to wait (wait only, at most ${MAX_WAIT_MS})`,
  )),
});

export interface VmToolsOptions {
  screen: VmScreen;
}

/** Build the screen tool set of a stella session. */
export function createVmTools(options: VmToolsOptions): Tool[] {
  return [
    createScreenshotTool(options),
    createActTool(options),
  ];
}

function createScreenshotTool(
  { screen }: VmToolsOptions,
): Tool<typeof screenshotSchema> {
  return {
    name: TOOL_VM_SCREENSHOT,
    label: "VM Screenshot",
    description:
      `Take a screenshot of the machine's screen and return it as an image ` +
      `(${VM_SCREEN_WIDTH}x${VM_SCREEN_HEIGHT}). The mouse pointer is drawn ` +
      "in the image, so its position and what is under it are visible. An " +
      "image pixel is a screen pixel: read a position off this image and " +
      "pass it to vm_act as-is.",
    parameters: screenshotSchema,
    execute: async (_id, _params, signal): Promise<ToolResult> => {
      const png = await screen.screenshot(signal);
      return {
        content: [
          {
            type: "text",
            text:
              `The screen is ${VM_SCREEN_WIDTH}x${VM_SCREEN_HEIGHT} pixels ` +
              "(1:1 with vm_act's coordinates).",
          },
          { type: "image", data: bytesToBase64(png), mimeType: "image/png" },
        ],
        details: { width: VM_SCREEN_WIDTH, height: VM_SCREEN_HEIGHT },
      };
    },
  };
}

function createActTool({ screen }: VmToolsOptions): Tool<typeof actSchema> {
  return {
    name: TOOL_VM_ACT,
    label: "VM Act",
    description:
      `Operate the machine's screen: move the pointer, click, drag, scroll, ` +
      `type text, press a key, or wait for the screen to settle. Positions ` +
      `are screen pixels (${VM_SCREEN_WIDTH}x${VM_SCREEN_HEIGHT}), read off ` +
      "the most recent vm_screenshot. Take a screenshot afterwards to see " +
      "the result — this tool never reports what the screen looks like.",
    parameters: actSchema,
    async execute(_id, params, signal): Promise<ToolResult> {
      const action = params.action.trim();
      switch (action) {
        case "move": {
          const x = requireCoord("x", params.x);
          const y = requireCoord("y", params.y);
          await screen.move(x, y, signal);
          return result(`moved to (${x}, ${y}).`, { x, y });
        }
        case "click": {
          const x = requireCoord("x", params.x);
          const y = requireCoord("y", params.y);
          const button = requireOneOf(
            "button",
            params.button ?? "left",
            [
              "left",
              "right",
              "middle",
            ] as const,
          );
          const count = requireIntegerInRange("count", params.count ?? 1, 1, 3);
          await screen.click(x, y, { button, count }, signal);
          return result(
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
          const button = requireOneOf(
            "button",
            params.button ?? "left",
            [
              "left",
              "right",
              "middle",
            ] as const,
          );
          await screen.drag(x, y, toX, toY, button, signal);
          return result(
            `dragged ${button} from (${x}, ${y}) to (${toX}, ${toY}).`,
            { from: { x, y }, to: { x: toX, y: toY }, button },
          );
        }
        case "scroll": {
          const x = requireCoord("x", params.x);
          const y = requireCoord("y", params.y);
          const vertical = params.vertical ?? 0;
          const horizontal = params.horizontal ?? 0;
          if (vertical === 0 && horizontal === 0) {
            throw new CoreError(
              "scroll needs a vertical or horizontal amount",
              "invalid",
            );
          }
          await screen.scroll(x, y, { vertical, horizontal }, signal);
          return result(
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
          return result(`typed ${text.length} character(s).`, {
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
          return result(`pressed ${key}.`, { key });
        }
        case "wait": {
          const durationMs = requireIntegerInRange(
            "duration_ms",
            params.duration_ms ?? 1000,
            1,
            MAX_WAIT_MS,
          );
          await sleepAbortable(durationMs, signal, abortError);
          return result(`waited ${durationMs}ms.`, { durationMs });
        }
        default:
          throw new CoreError(
            `Unknown action "${params.action}". Use move, click, drag, ` +
              "scroll, type, key or wait.",
            "invalid",
          );
      }
    },
  };
}

/** One tool result: the sentence above plus the resolved arguments, so a
 * mis-click is diagnosable from the transcript alone. */
function result(
  text: string,
  details: Record<string, unknown>,
): ToolResult {
  return { content: [{ type: "text", text }], details };
}
