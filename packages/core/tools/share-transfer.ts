/**
 * Moving one file between the machine and a folder the user lent.
 *
 * `read` and `write` already reach a lent folder (see share/mounted-files.ts),
 * but they carry TEXT: a picture read as text is garbled, and a file written
 * that way is not the same bytes. The two tools below exist for exactly the
 * files those tools are wrong for — a screenshot the agent made, an archive,
 * a PDF the user put in the folder — and they move bytes without decoding
 * them anywhere along the road (the machine's `base64`, the wire's base64, the
 * lent computer's `base64` again).
 *
 * Direction is a tool's name rather than a parameter: "upload" and "download"
 * are how the user says it, and a model that picks the wrong path for the
 * direction is told which tool it wanted instead of quietly getting the
 * reverse.
 */
import { isSharePath } from "../share/grant.ts";
import { TOOL_SHARE_DOWNLOAD, TOOL_SHARE_UPLOAD } from "../shared/mod.ts";
import type { FileBackend } from "./file-backend.ts";
import { requireResolved } from "./resolve.ts";
import { object, string, type Tool, type ToolResult } from "./schema.ts";

/** Largest file one call moves. The conversation can already attach 16 MiB to
 * one message, so this is generous for the files people hand an agent (a
 * screenshot, a spreadsheet export, a zip) while keeping one call's work
 * bounded; bigger things belong in a workspace, not a loan. */
export const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;

/** Bytes per read/write on the wire. One frame stays a few megabytes at most,
 * and the whole file never has to sit in memory on either side. */
export const TRANSFER_CHUNK_BYTES = 1024 * 1024;

type Direction = "upload" | "download";

const transferSchema = object({
  path: string("The existing file to copy."),
  to: string("Where to write the copy."),
});

/** A size as the model reads it, in the units people use for files. */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Copy `from` to `to`, whichever side of the loan each is on.
 *
 * Both paths go through the session's one file backend, so the model does not
 * have to know which machine a path is on — but this tool does, because a
 * copy inside one machine is `bash`'s job and a copy that never crosses the
 * loan would silently do nothing useful.
 */
async function transfer(
  files: FileBackend,
  from: string,
  to: string,
  direction: Direction,
): Promise<ToolResult> {
  const source = await requireResolved(files, from);
  const target = await requireResolved(files, to);
  const sourceLent = isSharePath(source);
  const targetLent = isSharePath(target);
  if (
    (direction === "upload" && (sourceLent || !targetLent)) ||
    (direction === "download" && (!sourceLent || targetLent))
  ) {
    throw new Error(
      direction === "upload"
        ? "share_upload copies a file from this machine into a lent folder: " +
            "`path` is a file here and `to` is under /lend. The other " +
            "direction is share_download."
        : "share_download copies a file out of a lent folder onto this " +
            "machine: `path` is under /lend and `to` is a path here. The " +
            "other direction is share_upload.",
    );
  }

  const stat = await files.stat(source);
  if (stat === undefined) throw new Error(`Path does not exist: ${from}`);
  if (!stat.isFile) throw new Error(`Is a directory: ${from}`);
  if (stat.size > MAX_TRANSFER_BYTES) {
    throw new Error(
      `${from} is ${sizeText(stat.size)}; one transfer carries at most ` +
        `${sizeText(MAX_TRANSFER_BYTES)}`,
    );
  }
  const existing = await files.stat(target);
  if (existing !== undefined && !existing.isFile) {
    throw new Error(`Is a directory: ${to}`);
  }

  // `append` is the second chunk's word for "the file is already open": the
  // first write truncates, so a shorter file does not leave the old tail.
  let offset = 0;
  let first = true;
  while (offset < stat.size) {
    const length = Math.min(TRANSFER_CHUNK_BYTES, stat.size - offset);
    const chunk = await files.readBytes(source, offset, length);
    if (chunk.length === 0) {
      throw new Error(
        `${from} ended after ${sizeText(offset)}, before the ${sizeText(
          stat.size,
        )} it reported: it changed while it was being copied`,
      );
    }
    await files.writeBytes(target, chunk, { append: !first });
    first = false;
    offset += chunk.length;
  }
  if (first) await files.writeBytes(target, new Uint8Array(0));

  return {
    content: [
      {
        type: "text",
        text: `Copied ${source} to ${target} (${sizeText(stat.size)})`,
      },
    ],
    details: {
      from: source,
      to: target,
      bytes: stat.size,
      direction,
    },
  };
}

/** `share_upload`: a file on this machine into a lent folder. */
export function createShareUploadTool(
  files: FileBackend,
): Tool<typeof transferSchema> {
  return {
    name: TOOL_SHARE_UPLOAD,
    label: "Upload to Lent Folder",
    description:
      "Copy a file from this machine into a folder the user lent from their " +
      "own computer. `path` is the file here; `to` is its place under /lend. " +
      "The bytes are copied unchanged, so pictures, archives and PDFs survive " +
      "— use this rather than read/write for anything that is not text. One " +
      "file up to 64 MB per call.",
    parameters: transferSchema,
    execute: async (_id, params) =>
      await transfer(files, params.path, params.to, "upload"),
  };
}

/** `share_download`: a file in a lent folder onto this machine. */
export function createShareDownloadTool(
  files: FileBackend,
): Tool<typeof transferSchema> {
  return {
    name: TOOL_SHARE_DOWNLOAD,
    label: "Download from Lent Folder",
    description:
      "Copy a file from a folder the user lent from their own computer onto " +
      "this machine. `path` is the file under /lend; `to` is where it lands " +
      "here. The bytes are copied unchanged. One file up to 64 MB per call.",
    parameters: transferSchema,
    execute: async (_id, params) =>
      await transfer(files, params.path, params.to, "download"),
  };
}

/** Both transfer tools, in the order the model reads them. */
export function createShareTransferTools(files: FileBackend): Tool[] {
  return [createShareUploadTool(files), createShareDownloadTool(files)];
}
