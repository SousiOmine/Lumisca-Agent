import { extname, join } from "node:path";
import type { Sandbox } from "../workspace/sandbox.ts";
import {
  TOOL_EDIT,
  TOOL_LIST_DIR,
  TOOL_READ_FILE,
  TOOL_WRITE_FILE,
} from "../shared.ts";
import { integer, object, optional, string, type Tool } from "./schema.ts";
import { DEFAULT_READ_LIMIT, truncate, truncatedNote } from "./truncate.ts";

interface FsToolContext {
  sandbox: Sandbox;
}

/** Raster image extensions read as image content blocks (vision models see
 * the pixels). Vector images (SVG) are XML and stay on the text path. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** Largest image handed to the model as an image block; anything bigger
 * falls back to the (garbled) text read. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fileInfoLine(entry: Deno.DirEntry): string {
  if (entry.isDirectory) return `${entry.name}/`;
  if (entry.isSymlink) return `${entry.name} -> (symlink)`;
  return `${entry.name}`;
}

const readSchema = object({
  path: string("Path to the file"),
  offset: optional(integer("Byte offset to start reading from")),
  limit: optional(integer("Maximum number of bytes to read")),
});

export function createReadFileTool(
  ctx: FsToolContext,
): Tool<typeof readSchema> {
  return {
    name: TOOL_READ_FILE,
    label: "Read File",
    description:
      "Read a file's contents as text. `offset` and `limit` are in bytes. " +
      "Large files are read in chunks; the output is truncated to the last portion when larger than 64KB. " +
      "Raster images (PNG/JPEG/GIF/WebP/BMP, up to 10MB) are passed to the model as images when read in full.",
    parameters: readSchema,
    execute: async (_id, params, _signal) => {
      const resolved = await ctx.sandbox.resolve(params.path);
      if (!resolved.ok) throw new Error(resolved.reason);
      const stat = await Deno.stat(resolved.path);
      if (stat.isDirectory) throw new Error(`Is a directory: ${params.path}`);
      const wholeFile = params.offset === undefined &&
        params.limit === undefined;
      // Whole-file reads of raster images become an image block (vision
      // models see the pixels); everything else stays on the text path.
      const mimeType = IMAGE_MIME_BY_EXT[extname(resolved.path).toLowerCase()];
      if (wholeFile && mimeType !== undefined && stat.size <= MAX_IMAGE_BYTES) {
        const file = await Deno.open(resolved.path, { read: true });
        try {
          const buffer = new Uint8Array(stat.size);
          let read = 0;
          while (read < buffer.length) {
            const n = await file.read(buffer.subarray(read));
            if (n === null) break;
            read += n;
          }
          const name = resolved.path.split(/[\\/]/).pop() ?? resolved.path;
          return {
            content: [
              { type: "text", text: `[image: ${name} (${read} bytes)]` },
              {
                type: "image",
                data: bytesToBase64(buffer.subarray(0, read)),
                mimeType,
              },
            ],
            details: { path: resolved.path, size: stat.size },
          };
        } finally {
          file.close();
        }
      }
      const offset = params.offset ?? 0;
      const limit = params.limit ?? DEFAULT_READ_LIMIT;
      const file = await Deno.open(resolved.path, { read: true });
      try {
        await file.seek(offset, Deno.SeekMode.Start);
        const buffer = new Uint8Array(limit);
        const read = await file.read(buffer);
        const bytes = read === null
          ? new Uint8Array(0)
          : buffer.subarray(0, read);
        const text = new TextDecoder().decode(bytes);
        const { text: trimmed, truncated } = truncate(text);
        let note = "";
        if (truncated) {
          note = truncatedNote("output");
        }
        if (offset + bytes.length < stat.size) {
          note += `\n[file continues; read with offset=${
            offset + bytes.length
          }]`;
        }
        return {
          content: [{ type: "text", text: trimmed + note }],
          details: { path: resolved.path, size: stat.size },
        };
      } finally {
        file.close();
      }
    },
  };
}

const writeSchema = object({
  path: string("Path to the file"),
  content: string("Full text content to write"),
});

export function createWriteFileTool(
  ctx: FsToolContext,
): Tool<typeof writeSchema> {
  return {
    name: TOOL_WRITE_FILE,
    label: "Write File",
    description:
      "Create or overwrite a file with the given text content. Parent directories are created automatically.",
    parameters: writeSchema,
    execute: async (_id, params) => {
      const resolved = await ctx.sandbox.resolve(params.path);
      if (!resolved.ok) throw new Error(resolved.reason);
      const parent = join(resolved.path, "..");
      const parentResolved = await ctx.sandbox.resolve(parent);
      if (!parentResolved.ok) throw new Error(parentResolved.reason);
      await Deno.mkdir(parentResolved.path, { recursive: true });
      await Deno.writeTextFile(resolved.path, params.content);
      return {
        content: [{ type: "text", text: `Wrote ${resolved.path}` }],
        details: { path: resolved.path, bytes: params.content.length },
      };
    },
  };
}

const editSchema = object({
  path: string("Path to the file"),
  old_string: string("Text to find (exact match)"),
  new_string: string("Replacement text"),
});

export function createEditFileTool(
  ctx: FsToolContext,
): Tool<typeof editSchema> {
  return {
    name: TOOL_EDIT,
    label: "Edit File",
    description:
      "Replace the first occurrence of `old_string` with `new_string` in a file. " +
      "`old_string` must match exactly and appear at least once.",
    parameters: editSchema,
    execute: async (_id, params) => {
      const resolved = await ctx.sandbox.resolve(params.path);
      if (!resolved.ok) throw new Error(resolved.reason);
      const content = await Deno.readTextFile(resolved.path);
      const occurrences = content.split(params.old_string).length - 1;
      if (occurrences === 0) {
        throw new Error(`old_string not found in ${params.path}`);
      }
      const updated = content.replace(params.old_string, params.new_string);
      await Deno.writeTextFile(resolved.path, updated);
      const note = occurrences > 1
        ? `\n[warning: old_string appeared ${occurrences} times; only the first was replaced]`
        : "";
      return {
        content: [{
          type: "text",
          text: `Edited ${resolved.path}${note}`,
        }],
        details: { path: resolved.path, replacements: 1, occurrences },
      };
    },
  };
}

const listDirSchema = object({
  path: string("Path to the directory"),
});

export function createListDirTool(
  ctx: FsToolContext,
): Tool<typeof listDirSchema> {
  return {
    name: TOOL_LIST_DIR,
    label: "List Directory",
    description: "List the contents of a directory within the workspace.",
    parameters: listDirSchema,
    execute: async (_id, params) => {
      const resolved = await ctx.sandbox.resolve(params.path);
      if (!resolved.ok) throw new Error(resolved.reason);
      const entries: Deno.DirEntry[] = [];
      for await (const entry of Deno.readDir(resolved.path)) {
        entries.push(entry);
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const lines = entries.map((e) => fileInfoLine(e));
      const { text, truncated } = truncate(lines.join("\n") || "(empty)");
      const note = truncated ? truncatedNote("listing") : "";
      return {
        content: [{ type: "text", text: `${resolved.path}:\n${text}${note}` }],
        details: { path: resolved.path, count: entries.length },
      };
    },
  };
}
