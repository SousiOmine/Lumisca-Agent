/**
 * The stella machine's screen: screenshots for the agent, and the VNC bridge
 * the chat's screen pane connects to.
 *
 * Coordinates are the reason this module is careful. The agent reads a
 * position off a screenshot and hands it back to be clicked, so the picture
 * it was given and the pixels an input event reaches must be the same space.
 * The screen is therefore a fixed 1280x800 (vm/contract.ts) and a capture is
 * never resized: what the agent sees is 1:1 with what it clicks.
 */

import type { VmExec, VmExecBytes } from "./container.ts";
import {
  VM_SCREEN_HEIGHT,
  VM_SCREEN_WIDTH,
  VM_SCROLL_MAX_NOTCHES,
  VM_SCROLL_NOTCH,
} from "./contract.ts";

/** Screenshot bounds: enough for a 1280x800 PNG and nothing more. */
const SCREENSHOT_TIMEOUT_MS = 20_000;
const SCREENSHOT_MAX_BYTES = 16 * 1024 * 1024;

/** Input actions are quick; a hung X server must not stall the run. */
const ACTION_TIMEOUT_MS = 20_000;

export interface VmScreen {
  /** Capture the whole screen as PNG bytes. The pointer is included: the
   * agent needs to see where it is and what it is hovering. */
  screenshot(signal?: AbortSignal): Promise<Uint8Array>;
  /** Move the pointer without clicking. */
  move(x: number, y: number, signal?: AbortSignal): Promise<void>;
  /** Drag with `button` held from one position to another. */
  drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    button: "left" | "right" | "middle",
    signal?: AbortSignal,
  ): Promise<void>;
  /** Click at a position; `count` 2 double-clicks, 3 triple-clicks. */
  click(
    x: number,
    y: number,
    options: { button: "left" | "right" | "middle"; count: number },
    signal?: AbortSignal,
  ): Promise<void>;
  /** Type text as if from the keyboard. */
  type(text: string, signal?: AbortSignal): Promise<void>;
  /** Press one key by xdotool's key name (e.g. `Return`, `ctrl+a`). */
  key(key: string, signal?: AbortSignal): Promise<void>;
  /** Scroll at a position; positive `delta` scrolls down/right. */
  scroll(
    x: number,
    y: number,
    delta: { vertical: number; horizontal: number },
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface VmScreenOptions {
  /** Text-command seam (xdotool) — the same one the file and shell backends
   * use. */
  exec: VmExec;
  /** Byte-command seam: a capture must not pass through a text decode. */
  execBytes: VmExecBytes;
}

/** One xdotool call; a non-zero exit becomes a readable error. */
async function xdotool(
  exec: VmExec,
  args: readonly string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await exec(["xdotool", ...args], {
    timeoutMs: ACTION_TIMEOUT_MS,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (result.timedOut) {
    throw new Error(
      `The machine did not answer the ${args[0] ?? "input"} action within ${
        ACTION_TIMEOUT_MS / 1000
      } seconds`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `xdotool ${args[0] ?? ""} failed with exit code ${result.exitCode}`,
    );
  }
}

/** Reject a coordinate outside the screen instead of clicking at a clamped
 * position: a silently moved click is a wrong action, not a corrected one. */
function requireOnScreen(x: number, y: number): void {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= VM_SCREEN_WIDTH ||
    y >= VM_SCREEN_HEIGHT
  ) {
    throw new Error(
      `The position (${x}, ${y}) is outside the screen ` +
        `(${VM_SCREEN_WIDTH}x${VM_SCREEN_HEIGHT}); take a screenshot and read ` +
        "the position off it",
    );
  }
}

export function createVmScreen(options: VmScreenOptions): VmScreen {
  const { exec } = options;

  return {
    async screenshot(signal) {
      // scrot draws the pointer into the image (X does not include it in a
      // plain capture), and `--overwrite` is what lets it write to stdout.
      const result = await options.execBytes(
        ["scrot", "--pointer", "--overwrite", "--silent", "/dev/stdout"],
        {
          timeoutMs: SCREENSHOT_TIMEOUT_MS,
          maxOutput: SCREENSHOT_MAX_BYTES,
          ...(signal !== undefined ? { signal } : {}),
        },
      );
      if (result.timedOut) {
        throw new Error(
          `Taking a screenshot took more than ${
            SCREENSHOT_TIMEOUT_MS / 1000
          } seconds`,
        );
      }
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr.trim() ||
            `Could not take a screenshot (exit code ${result.exitCode})`,
        );
      }
      if (result.stdout.byteLength === 0) {
        throw new Error("The screenshot was empty");
      }
      if (result.truncated) {
        throw new Error(
          `The screenshot is larger than ${
            SCREENSHOT_MAX_BYTES / (1024 * 1024)
          }MB`,
        );
      }
      return result.stdout;
    },

    async move(x, y, signal) {
      requireOnScreen(x, y);
      await xdotool(exec, ["mousemove", String(x), String(y)], signal);
    },

    async drag(fromX, fromY, toX, toY, button, signal) {
      requireOnScreen(fromX, fromY);
      requireOnScreen(toX, toY);
      // xdotool interpolates the movement: a drag that jumps in one step
      // never triggers the hover/drag states the target application watches.
      await xdotool(
        exec,
        [
          "mousemove",
          String(fromX),
          String(fromY),
          "mousedown",
          button,
          "mousemove",
          "--sync",
          String(toX),
          String(toY),
          "mouseup",
          button,
        ],
        signal,
      );
    },

    async click(x, y, clickOptions, signal) {
      requireOnScreen(x, y);
      await xdotool(
        exec,
        [
          "mousemove",
          String(x),
          String(y),
          "click",
          "--repeat",
          String(clickOptions.count),
          clickOptions.button,
        ],
        signal,
      );
    },

    async type(text, signal) {
      if (text.length === 0) return;
      // `--clearmodifiers` keeps a modifier left over from a previous key
      // press from mangling the text; `--delay` gives the target application
      // time to keep up with fast input.
      await xdotool(
        exec,
        ["type", "--clearmodifiers", "--delay", "12", "--", text],
        signal,
      );
    },

    async key(key, signal) {
      if (key.trim().length === 0) {
        throw new Error("A key name is required (e.g. `Return`, `ctrl+a`)");
      }
      await xdotool(exec, ["key", "--clearmodifiers", "--", key], signal);
    },

    async scroll(x, y, delta, signal) {
      requireOnScreen(x, y);
      await xdotool(exec, ["mousemove", String(x), String(y)], signal);
      // X11's wheel buttons are 4 up, 5 down, 6 left, 7 right, and they name
      // the direction the WHEEL rolls rather than the direction the content
      // moves: button 5 rolls down and the page scrolls down. A positive
      // amount therefore means "down"/"right", matching the tool's schema
      // ("positive scrolls down") and what a person reading a page expects.
      const vertical =
        delta.vertical === 0 ? [] : [delta.vertical > 0 ? "5" : "4"];
      const horizontal =
        delta.horizontal === 0 ? [] : [delta.horizontal > 0 ? "7" : "6"];
      const buttons = [...vertical, ...horizontal];
      if (buttons.length === 0) return;
      // One wheel click is one notch, so an amount is divided by the notch
      // size (see VM_SCROLL_NOTCH) and capped: a request cannot spin a list
      // for minutes.
      const repeats = scrollNotches(delta);
      for (const button of buttons) {
        await xdotool(
          exec,
          ["click", "--repeat", String(repeats), button],
          signal,
        );
      }
    },
  };
}

/** How many wheel notches one scroll amount means.
 *
 * Exported so the tool's result text and its schema describe the same rule
 * the machine applies: `vertical: 100` is one notch, and the cap keeps a
 * stray `vertical: 100000` from holding the run. */
export function scrollNotches(delta: {
  vertical: number;
  horizontal: number;
}): number {
  return Math.max(
    1,
    Math.min(
      VM_SCROLL_MAX_NOTCHES,
      Math.ceil(
        Math.max(Math.abs(delta.vertical), Math.abs(delta.horizontal)) /
          VM_SCROLL_NOTCH,
      ),
    ),
  );
}
