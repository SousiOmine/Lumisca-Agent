/**
 * The machine's clipboard, as the chat's screen pane exchanges text with it.
 *
 * The VNC connection is not the way: x11vnc speaks the standard RFB cut text,
 * which is ISO 8859-1 and has no UTF-8 option, so a Japanese message would
 * arrive as a row of question marks in either direction. The X CLIPBOARD
 * selection itself holds UTF-8, so each direction is one `podman exec`
 * running `xclip`.
 *
 * A write outlives its call: `xclip -i` forks and stays as the selection's
 * owner, serving the text to whatever asks for it later (the application the
 * user pastes into). It survives the exec that started it — measured on the
 * machine image — so the write reads its own text back before answering: a
 * machine where that did not hold fails here instead of delivering an empty
 * paste.
 */
import { CoreError } from "../errors.ts";
import { firstLine } from "../lines.ts";
import type { VmExec, VmExecResult } from "./container.ts";

/** Bound for one call. Both are local `podman exec`s that only touch the X
 * server; the bound exists to end a wedged machine, not to allow for work. */
const CLIPBOARD_TIMEOUT_MS = 5_000;

/** Largest text either direction carries, in characters. A clipboard is
 * something a person copied, not a file transfer: this bounds the HTTP body
 * and the message, and longer text is refused rather than cut (a cut paste
 * would look like the machine lost the rest of it). */
export const VM_CLIPBOARD_MAX_CHARS = 100_000;

/** Bytes allowed back from a read: UTF-8 is at most 4 bytes per character,
 * and the extra room covers a trailing newline. */
const CLIPBOARD_MAX_BYTES = VM_CLIPBOARD_MAX_CHARS * 4 + 64;

/** xclip's answer when no application owns the selection. Nothing was copied
 * yet, which is an empty clipboard rather than a broken machine. */
const NO_SELECTION = /target .* not available/i;

export interface VmClipboard {
  /** The machine's CLIPBOARD text; an empty string when nothing is selected
   * (no application owns the selection, or it holds no text). */
  read(signal?: AbortSignal): Promise<string>;
  /** Put `text` on the machine's CLIPBOARD, so the application the user is
   * looking at can paste it. */
  write(text: string, signal?: AbortSignal): Promise<void>;
}

export interface VmClipboardOptions {
  /** The text-command seam of the machine (see container.ts). */
  exec: VmExec;
}

/** The text as the machine should receive it: a browser copies Windows line
 * endings, and an application inside the machine would insert the `\r`
 * literally (a visible `^M` in a terminal). */
export function normalizeClipboardText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Why a call failed, in one sentence: xclip's own words when it said
 * something, its status otherwise. */
function failure(result: VmExecResult): string {
  if (result.timedOut) {
    return `The machine did not answer the clipboard within ${
      CLIPBOARD_TIMEOUT_MS / 1000
    } seconds`;
  }
  const detail = result.stderr.trim() === "" ? "" : firstLine(result.stderr);
  return detail === "" ? `xclip exited with code ${result.exitCode}` : detail;
}

export function createVmClipboard(options: VmClipboardOptions): VmClipboard {
  const { exec } = options;

  async function read(signal?: AbortSignal): Promise<string> {
    const result = await exec(["xclip", "-o", "-selection", "clipboard"], {
      timeoutMs: CLIPBOARD_TIMEOUT_MS,
      maxOutput: CLIPBOARD_MAX_BYTES,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (result.exitCode !== 0) {
      // An unowned selection is xclip's ordinary answer on a machine where
      // nothing was copied yet; every other failure is the machine's own
      // words (a missing `xclip` here means the image predates this code).
      if (NO_SELECTION.test(result.stderr)) return "";
      throw new CoreError(failure(result), "unavailable");
    }
    if (result.truncated) {
      throw new CoreError(
        `The machine's clipboard is larger than ${VM_CLIPBOARD_MAX_CHARS} characters; copy a smaller part of it`,
        "invalid",
      );
    }
    const text = result.stdout;
    if (text.length > VM_CLIPBOARD_MAX_CHARS) {
      throw new CoreError(
        `The machine's clipboard is larger than ${VM_CLIPBOARD_MAX_CHARS} characters; copy a smaller part of it`,
        "invalid",
      );
    }
    return text;
  }

  return {
    read,

    async write(text, signal) {
      const normalized = normalizeClipboardText(text);
      if (normalized.length === 0) return;
      if (normalized.length > VM_CLIPBOARD_MAX_CHARS) {
        throw new CoreError(
          `The text is longer than ${VM_CLIPBOARD_MAX_CHARS} characters; paste a smaller part of it`,
          "invalid",
        );
      }
      const result = await exec(["xclip", "-i", "-selection", "clipboard"], {
        // Through stdin, not an argument: the text is the user's (a password
        // among it), and an argv is readable by anything inside the machine
        // that lists processes.
        stdin: new TextEncoder().encode(normalized),
        timeoutMs: CLIPBOARD_TIMEOUT_MS,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (result.exitCode !== 0) {
        throw new CoreError(failure(result), "unavailable");
      }
      // The selection is served by the xclip this call started, from the
      // background. Ask for the text back once so a machine that dropped it
      // (an old image, an X server that refused the value) reports the
      // failure here rather than letting the paste arrive empty.
      if (await read(signal) !== normalized) {
        throw new CoreError(
          "The machine did not keep the text on its clipboard",
          "unavailable",
        );
      }
    },
  };
}
