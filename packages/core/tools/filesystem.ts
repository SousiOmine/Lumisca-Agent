import { join } from "node:path";
import { Type } from "npm:@earendil-works/pi-ai@0.83.0";
import type { AgentTool } from "npm:@earendil-works/pi-agent-core@0.83.0";
import type { Sandbox } from "../workspace/sandbox.ts";
import { DEFAULT_READ_LIMIT, MAX_TOOL_OUTPUT, truncate } from "./truncate.ts";

interface FsToolContext {
  sandbox: Sandbox;
  cwd: string;
}

function fileInfoLine(entry: Deno.DirEntry): string {
  if (entry.isDirectory) return `${entry.name}/`;
  if (entry.isSymlink) return `${entry.name} -> (symlink)`;
  return `${entry.name}`;
}

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file" }),
  offset: Type.Optional(
    Type.Integer({ description: "Byte offset to start reading from" }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Maximum number of bytes to read" }),
  ),
});

export function createReadFileTool(
  ctx: FsToolContext,
): AgentTool<typeof readSchema> {
  return {
    name: "read_file",
    label: "Read File",
    description:
      "Read a file's contents as text. `offset` and `limit` are in bytes. " +
      "Large files are read in chunks; the output is truncated to the last portion when larger than 64KB.",
    parameters: readSchema,
    execute: async (_id, params, signal) => {
      const resolved = await ctx.sandbox.resolve(params.path, ctx.cwd);
      if (!resolved.ok) throw new Error(resolved.reason);
      const stat = await Deno.stat(resolved.path);
      if (stat.isDirectory) throw new Error(`Is a directory: ${params.path}`);
      const offset = params.offset ?? 0;
      const limit = params.limit ?? DEFAULT_READ_LIMIT;
      const file = await Deno.open(resolved.path, { read: true });
      try {
        await file.seek(offset, Deno.SeekMode.Start);
        const buffer = new Uint8Array(limit);
        const read = await file.read(buffer);
        const bytes = read === null ? new Uint8Array(0) : buffer.subarray(0, read);
        const text = new TextDecoder().decode(bytes);
        const { text: trimmed, truncated } = truncate(text);
        let note = "";
        if (truncated) note = `\n[output truncated to the last ${MAX_TOOL_OUTPUT} bytes]`;
        if (offset + bytes.length < stat.size) {
          note += `\n[file continues; read with offset=${offset + bytes.length}]`;
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

const writeSchema = Type.Object({
  path: Type.String({ description: "Path to the file" }),
  content: Type.String({ description: "Full text content to write" }),
});

export function createWriteFileTool(
  ctx: FsToolContext,
): AgentTool<typeof writeSchema> {
  return {
    name: "write_file",
    label: "Write File",
    description:
      "Create or overwrite a file with the given text content. Parent directories are created automatically.",
    parameters: writeSchema,
    execute: async (_id, params) => {
      const resolved = await ctx.sandbox.resolve(params.path, ctx.cwd);
      if (!resolved.ok) throw new Error(resolved.reason);
      const parent = join(resolved.path, "..");
      const parentResolved = await ctx.sandbox.resolve(parent, ctx.cwd);
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

const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file" }),
  old_string: Type.String({ description: "Text to find (exact match)" }),
  new_string: Type.String({ description: "Replacement text" }),
});

export function createEditFileTool(
  ctx: FsToolContext,
): AgentTool<typeof editSchema> {
  return {
    name: "edit",
    label: "Edit File",
    description:
      "Replace the first occurrence of `old_string` with `new_string` in a file. " +
      "`old_string` must match exactly and appear at least once.",
    parameters: editSchema,
    execute: async (_id, params) => {
      const resolved = await ctx.sandbox.resolve(params.path, ctx.cwd);
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

const listDirSchema = Type.Object({
  path: Type.String({ description: "Path to the directory" }),
});

export function createListDirTool(
  ctx: FsToolContext,
): AgentTool<typeof listDirSchema> {
  return {
    name: "list_dir",
    label: "List Directory",
    description: "List the contents of a directory within the workspace.",
    parameters: listDirSchema,
    execute: async (_id, params) => {
      const resolved = await ctx.sandbox.resolve(params.path, ctx.cwd);
      if (!resolved.ok) throw new Error(resolved.reason);
      const entries: Deno.DirEntry[] = [];
      for await (const entry of Deno.readDir(resolved.path)) {
        entries.push(entry);
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const lines = entries.map((e) => fileInfoLine(e));
      const { text, truncated } = truncate(lines.join("\n") || "(empty)");
      const note = truncated ? `\n[listing truncated to the last ${MAX_TOOL_OUTPUT} bytes]` : "";
      return {
        content: [{ type: "text", text: `${resolved.path}:\n${text}${note}` }],
        details: { path: resolved.path, count: entries.length },
      };
    },
  };
}
