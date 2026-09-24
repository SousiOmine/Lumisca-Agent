import { TOOL_PRESENT } from "../shared/mod.ts";
import { array, object, optional, string, type Tool } from "./schema.ts";
import { requireResolved } from "./resolve.ts";
import type { FsToolContext } from "./context.ts";

const presentSchema = object({
  files: array(
    object({
      path: string(
        "Path of an existing file, in the same form the file tools take: " +
          "absolute, or relative with a workspace folder name as the first " +
          "segment, e.g. `Aaa/docs/report.pdf`",
      ),
      description: optional(string(
        "Short description of the file for the user (one line)",
      )),
    }),
    "The files to declare, in display order (at least one)",
  ),
});

/** Declare files as deliverables of the session. The tool marks the files
 * the user asked to receive; the chat lists them under the conversation,
 * after the agent's reply. It never copies or moves anything: the list
 * points at the file as it exists on disk, so a later change to the file is
 * what the user sees. */
export function createPresentTool(
  ctx: FsToolContext,
): Tool<typeof presentSchema> {
  return {
    name: TOOL_PRESENT,
    label: "Present",
    description:
      "Declare files as final deliverables of this session, so the UI can " +
      "list them for the user after your reply. Nothing is copied or moved: " +
      "the list points at the files on disk, so later edits are what the " +
      "user sees. A `path` that does not exist fails, and a directory fails " +
      "with `Is a directory: <path>`.",
    parameters: presentSchema,
    execute: async (_id, params) => {
      const lines: string[] = [];
      const files: Array<{ path: string; description?: string }> = [];

      for (const file of params.files) {
        const filePath = await requireResolved(ctx.sandbox, file.path);
        const stat = await Deno.stat(filePath);
        if (stat.isDirectory) {
          throw new Error(`Is a directory: ${file.path}`);
        }
        files.push(
          file.description === undefined
            ? { path: file.path }
            : { path: file.path, description: file.description },
        );
        lines.push(
          file.description === undefined
            ? file.path
            : `${file.path} — ${file.description}`,
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { files },
      };
    },
  };
}
