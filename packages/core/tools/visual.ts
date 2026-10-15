import { basename, extname } from "node:path";
import {
  isVisualExtension,
  maxVisualBytes,
  TOOL_VISUAL,
  VISUAL_EXTENSIONS,
  VISUAL_MIME_BY_EXTENSION,
  visualRef,
} from "../shared/mod.ts";
import type { Sandbox } from "../workspace/sandbox.ts";
import type { SessionVisualStore } from "../session/visuals.ts";
import { object, optional, string, type Tool } from "./schema.ts";
import { requireExistingFile } from "./resolve.ts";

const visualSchema = object({
  path: string(
    "Path of an existing image file, in the same form the file tools take: " +
      "absolute, or relative with a workspace folder name as the first " +
      "segment, e.g. `Aaa/docs/chart.png`",
  ),
  caption: optional(string(
    "Short description of the image for the user (one line). It becomes the " +
      "image's alternative text; the file name is used when omitted.",
  )),
});

/** What the tool publishes for: the session's asset store and its id. The
 * sandbox comes from the tool set that hosts the tool, because a file path
 * resolves against the workspace, not against the session. */
export interface VisualTarget {
  store: SessionVisualStore;
  sessionId: string;
}

/** Publish an image file so the agent can show it inside its reply. The file
 * is copied into the session's store (the reply then links the copy, so what
 * the user sees does not change when the original does), and the result
 * carries the markdown snippet to paste. Coding sessions only: a chat
 * session has no workspace to read an image from. */
export function createVisualTool(
  options: VisualTarget & { sandbox: Sandbox },
): Tool<typeof visualSchema> {
  const { store, sessionId, sandbox } = options;
  return {
    name: TOOL_VISUAL,
    label: "Visual",
    description:
      "Publish an image file so it can be shown in your reply. The file is " +
      "copied into the session's visual store, and the result carries the " +
      "markdown image snippet to paste where the image belongs. `path` takes " +
      "the same form as the file tools (absolute, or relative with a " +
      "workspace folder name first). Supported: PNG / JPEG / GIF / WebP / " +
      "BMP up to 4 MiB, SVG up to 256 KiB. A path outside the workspace, a " +
      "missing file, a non-image file, and an oversized file fail.",
    parameters: visualSchema,
    execute: async (_id, params) => {
      // The sandbox resolves a path that does not exist yet (the file tools
      // create files that way); this tool only reads, so a missing file is
      // refused here.
      const filePath = await requireExistingFile(sandbox, params.path);
      // Still needed below: the size limit is checked before the file is read.
      const stat = await Deno.stat(filePath);
      const extension = extname(filePath).toLowerCase();
      if (!isVisualExtension(extension)) {
        throw new Error(
          `Only ${VISUAL_EXTENSIONS.join(", ")} images can be published; ` +
            `this is not one: ${params.path}`,
        );
      }
      const limit = maxVisualBytes(extension);
      if (stat.size > limit) {
        throw new Error(
          `Too large to publish: ${stat.size} bytes (the limit is ${limit}): ` +
            params.path,
        );
      }
      const bytes = await Deno.readFile(filePath);
      if (extension === ".svg") {
        // The same rule the fence follows: a diagram never carries script.
        // An image context would not run it, and the asset route refuses to
        // serve one that could, so a script can only ever be a surprise.
        const source = new TextDecoder().decode(bytes);
        if (/<script[\s>]/i.test(source)) {
          throw new Error(
            `An SVG with a <script> cannot be published: ${params.path}`,
          );
        }
      }
      const name = await store.put(sessionId, bytes, extension);
      const ref = visualRef(name);
      const caption = snippetCaption(
        params.caption,
        basename(filePath),
        name,
      );
      return {
        content: [{
          type: "text" as const,
          text: `Published as \`${ref}\`.\n\n` +
            "Put this markdown where the image belongs in your reply:\n\n" +
            `![${caption}](${ref})`,
        }],
        details: {
          ref,
          mimeType: VISUAL_MIME_BY_EXTENSION[extension],
          bytes: bytes.byteLength,
        },
      };
    },
  };
}

/** The alternative text the returned snippet carries: the caption the agent
 * gave, else the file's name, else the asset's own name. */
function snippetCaption(
  caption: string | undefined,
  file: string,
  name: string,
): string {
  const wanted = cleanCaption(caption ?? "");
  if (wanted !== "") return wanted;
  const fromFile = cleanCaption(file);
  return fromFile === "" ? name : fromFile;
}

/** Drop what would break the markdown the agent pastes: a closing bracket
 * ends the link text and a line break ends the line. */
function cleanCaption(text: string): string {
  return text.replace(/[[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}
