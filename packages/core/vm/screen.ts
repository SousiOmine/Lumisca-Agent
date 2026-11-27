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

import { createVmClipboard, type VmClipboard } from "./clipboard.ts";
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

/** How long xclip gets to take the selection before the paste key is sent,
 * and how long the application gets to read it before the clipboard is put
 * back. Both are the waits a11y.py uses for the same two steps. */
const PASTE_SETTLE_MS = 200;
const PASTE_READ_MS = 300;

/** xdotool's button numbers. Its `click` and `mousedown` commands take a
 * NUMBER, not a name: `xdotool click left` reads "left" as 0 and the X server
 * rejects the event with BadValue, so a click never lands. The tool layer
 * speaks names; this is where they become the numbers X expects. */
const XDOTOOL_BUTTON: Record<"left" | "middle" | "right", string> = {
  left: "1",
  middle: "2",
  right: "3",
};

function xdotoolButton(button: "left" | "middle" | "right"): string {
  return XDOTOOL_BUTTON[button];
}

export interface VmScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VmScreen {
  /** Capture the whole screen, or one region of it, as PNG bytes. The
   * pointer is included: the agent needs to see where it is and what it is
   * hovering. A region is returned 1:1, so a small area can be read without
   * the rest of the desktop. */
  screenshot(
    region: VmScreenRegion | undefined,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
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
  /** The machine's clipboard, for text the keyboard cannot carry. Built on
   * `exec` when it is not given. */
  clipboard?: VmClipboard;
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

/** Reject a region that is not an integer rectangle inside the screen. A
 * silently clipped capture would hide the part the agent asked to see. */
function requireRegionOnScreen(region: VmScreenRegion): void {
  for (const [name, value] of [
    ["region.x", region.x],
    ["region.y", region.y],
    ["region.width", region.width],
    ["region.height", region.height],
  ] as const) {
    if (!Number.isInteger(value)) {
      throw new Error(`${name} must be an integer (got ${value})`);
    }
  }
  if (
    region.width < 1 ||
    region.height < 1 ||
    region.x < 0 ||
    region.y < 0 ||
    region.x + region.width > VM_SCREEN_WIDTH ||
    region.y + region.height > VM_SCREEN_HEIGHT
  ) {
    throw new Error(
      `The region (${region.x}, ${region.y}) ${region.width}x${region.height} ` +
        `is outside the screen (${VM_SCREEN_WIDTH}x${VM_SCREEN_HEIGHT})`,
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

/** The characters xdotool can print: the X keyboard map carries printable
 * ASCII and nothing else. A character outside it is sent by xdotool through a
 * temporary keycode, and Chromium drops some of those — a seven-character
 * Japanese word arrived with four of them missing. */
function printedByXdotool(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 32 && code <= 126;
}

/** One piece of a typed string, and the way it goes out. `type` is printable
 * ASCII through the keyboard, `paste` is everything else through the
 * clipboard, and `key` is a line break or a tab, which are keys rather than
 * text in a field. */
export type VmTypeSegment =
  | { kind: "type"; text: string }
  | { kind: "paste"; text: string }
  | { kind: "key"; key: string };

/**
 * Split a string into the pieces each route can carry.
 *
 * The order is the string's order, so a mixed sentence arrives as written.
 * Adjacent characters of the same route are joined: one clipboard write per
 * run, not per character, and one xdotool call per typed run.
 *
 * A line break is Return rather than a pasted character. That is what
 * xdotool type did with it, and it is what submits a form or starts a line;
 * a pasted newline would do nothing in a single-line field. A tab is Tab for
 * the same reason.
 */
export function typeSegments(text: string): VmTypeSegment[] {
  const segments: VmTypeSegment[] = [];
  const addText = (kind: "type" | "paste", value: string): void => {
    const last = segments.at(-1);
    if (last !== undefined && last.kind === kind) {
      last.text += value;
      return;
    }
    segments.push({ kind, text: value });
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;
    if (character === "\r") {
      // A Windows line ending is one Return, not two.
      if (text[index + 1] === "\n") index += 1;
      segments.push({ kind: "key", key: "Return" });
      continue;
    }
    if (character === "\n") {
      segments.push({ kind: "key", key: "Return" });
      continue;
    }
    if (character === "\t") {
      segments.push({ kind: "key", key: "Tab" });
      continue;
    }
    addText(printedByXdotool(character) ? "type" : "paste", character);
  }
  return segments;
}

function paused(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createVmScreen(options: VmScreenOptions): VmScreen {
  const { exec } = options;
  const clipboard = options.clipboard ?? createVmClipboard({ exec });

  /**
   * Send text the keyboard cannot carry: put it on the clipboard, press the
   * paste key, and put the old clipboard back.
   *
   * The clipboard is the machine's own, which the chat's screen pane also
   * exchanges text with, so the text found there is restored as soon as the
   * paste lands. A paste is the only route that carries a character the X
   * keyboard map lacks, and it is what the in-machine helper's field write
   * already uses. The application must paste with Ctrl+V for this to arrive.
   */
  const paste = async (
    text: string,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    // A clipboard that cannot be read is one there is nothing to restore;
    // the write below is what reports a machine that cannot take the text.
    const previous = await clipboard.read(signal).catch(() => "");
    await clipboard.write(text, signal);
    // xclip forks a process that keeps serving the selection, so the paste
    // key goes out after it has taken ownership.
    await paused(PASTE_SETTLE_MS);
    await xdotool(exec, ["key", "--clearmodifiers", "--", "ctrl+v"], signal);
    // Restoring before the application has read the selection would paste
    // the restored text instead of this one.
    await paused(PASTE_READ_MS);
    if (previous !== "" && previous !== text) {
      // Best effort: the text already arrived, and a failed restore must not
      // report the typing as failed.
      await clipboard.write(previous, signal).catch(() => {});
    }
  };

  return {
    async screenshot(region, signal) {
      if (region !== undefined) requireRegionOnScreen(region);
      // scrot draws the pointer into the image (X does not include it in a
      // plain capture), and `--overwrite` is what lets it write to stdout.
      // `--area` crops to a screen rectangle; the tool turns the origin into
      // the screen-pixel offset the model needs.
      const args = ["scrot", "--pointer", "--overwrite", "--silent"];
      if (region !== undefined) {
        // `-a` is the short spelling every scrot version accepts; the
        // container's build need not know the long option.
        args.push(
          "-a",
          `${region.x},${region.y},${region.width},${region.height}`,
        );
      }
      args.push("/dev/stdout");
      const result = await options.execBytes(args, {
        timeoutMs: SCREENSHOT_TIMEOUT_MS,
        maxOutput: SCREENSHOT_MAX_BYTES,
        ...(signal !== undefined ? { signal } : {}),
      });
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
          xdotoolButton(button),
          "mousemove",
          "--sync",
          String(toX),
          String(toY),
          "mouseup",
          xdotoolButton(button),
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
          xdotoolButton(clickOptions.button),
        ],
        signal,
      );
    },

    async type(text, signal) {
      if (text.length === 0) return;
      // Each run goes the way that can carry it: printable ASCII through the
      // keyboard, anything else through the clipboard (see typeSegments).
      for (const segment of typeSegments(text)) {
        if (segment.kind === "paste") {
          await paste(segment.text, signal);
          continue;
        }
        if (segment.kind === "key") {
          await xdotool(
            exec,
            ["key", "--clearmodifiers", "--", segment.key],
            signal,
          );
          continue;
        }
        // `--clearmodifiers` keeps a modifier left over from a previous key
        // press from mangling the text; `--delay` gives the target
        // application time to keep up with fast input.
        await xdotool(
          exec,
          ["type", "--clearmodifiers", "--delay", "12", "--", segment.text],
          signal,
        );
      }
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
