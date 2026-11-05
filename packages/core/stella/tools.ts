import { CoreError } from "../errors.ts";
import { TOOL_AGENT_CREATE } from "../shared/mod.ts";
import type { FileBackend } from "../tools/file-backend.ts";
import { requireExistingFileWithSize } from "../tools/resolve.ts";
import {
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "../tools/schema.ts";
import {
  MAX_AGENT_NAME_CHARS,
  MAX_AGENT_ROLE_CHARS,
  type StellaAgent,
} from "./agents.ts";

/** The largest a role file may be before it is read. A role is at most
 * MAX_AGENT_ROLE_CHARS characters and UTF-8 never spends more than four
 * bytes on one character, so a longer file cannot fit whatever it holds.
 * The bound is about refusing an absurd file before transferring it; the
 * character limit itself stays in normalizeAgentInput, where every caller —
 * this tool included — is held to it. */
const MAX_AGENT_ROLE_FILE_BYTES = MAX_AGENT_ROLE_CHARS * 4;

const createSchema = object({
  name: string(
    `Name shown in the sidebar (1-${MAX_AGENT_NAME_CHARS} characters), in ` +
      "the user's words",
  ),
  role: optional(string(
    "What this agent is for and how it works, in the user's words: its job, " +
      "the tone it keeps, what it checks and when it asks. This becomes its " +
      `system prompt (at most ${MAX_AGENT_ROLE_CHARS} characters). Send this ` +
      "or role_file, not both",
  )),
  role_file: optional(string(
    "Path of a file in the machine holding the role text, in the same form " +
      "the file tools take (absolute, or relative to the working folder). " +
      "Read as UTF-8 and trimmed. Use this instead of role when the role is " +
      `long. At most ${MAX_AGENT_ROLE_CHARS} characters. Send this or role, ` +
      "not both",
  )),
});

export interface AgentCreateOptions {
  /** Create the agent and return it. Throws (conflict) for a taken name —
   * the core owns that rule, so the route and this tool cannot disagree. */
  create(input: { name: string; role: string }): StellaAgent;
  /** The session's file backend: `role_file` resolves against it, so a role
   * file is exactly a file this agent may read. */
  files: FileBackend;
}

/** The role text a file holds, or a sentence the caller can act on.
 *
 * Refuses rather than repairs. A file cut to fit, decoded leniently or
 * accepted while empty would give the new agent a role nobody wrote, and the
 * role is its system prompt from its first turn. */
async function roleFromFile(
  files: FileBackend,
  requested: string,
): Promise<{ role: string; path: string }> {
  const { path, size } = await requireExistingFileWithSize(files, requested);
  if (size > MAX_AGENT_ROLE_FILE_BYTES) {
    throw new CoreError(
      `The role file is ${size} bytes; a role is at most ` +
        `${MAX_AGENT_ROLE_CHARS} characters. Shorten it and try again.`,
      "invalid",
    );
  }
  // The whole file, in one read: the size was just checked, so this never
  // cuts it short.
  const { bytes } = await files.readHead(path, size);
  let text: string;
  try {
    // Strict decoding: a lenient decode turns a Shift_JIS brief into U+FFFD
    // and stores the mojibake as the agent's instructions.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CoreError(
      `The role file is not UTF-8 text: ${path}. Save it as UTF-8 and try ` +
        "again.",
      "invalid",
    );
  }
  if (text.trim() === "") {
    throw new CoreError(
      `The role file is empty: ${path}. Write the role into it, or send ` +
        "role instead.",
      "invalid",
    );
  }
  return { role: text, path };
}

/**
 * `agent_create`: add another agent to stella.
 *
 * The agent, not the user, is the one who knows what a new role should be by
 * the time it asks — so this is a tool rather than a form. It deliberately
 * does NOT ask the questions itself (there is no way to; the answer has to
 * come from the conversation), and it refuses to guess: the description says
 * to call it only after the user has said what they want.
 *
 * The role arrives as text (`role`) or as the path of a text file in the
 * machine (`role_file`), never both. The file form is for the long case: a
 * brief that already exists — an attachment the user sent, a document the
 * agent downloaded, a file it wrote earlier — is read from disk instead of
 * being typed back into a tool argument by the model, which costs the same
 * tokens again and can be cut short or paraphrased on the way.
 *
 * This mirrors Terasuma's `tera_create`, minus everything that does not earn
 * its place: no separate workspace folder (the files live in the machine) and
 * no identity-rewrite tool (a role is written once, at creation).
 */
export function createAgentCreateTool(
  options: AgentCreateOptions,
): Tool<typeof createSchema> {
  const { create, files } = options;
  return {
    name: TOOL_AGENT_CREATE,
    label: "Agent Create",
    description:
      "Create another agent: a separate agent with its own name, role " +
      "and ongoing conversation, shown in the sidebar. Its role becomes its " +
      "system prompt, so it works that way from its first turn. A name that " +
      "is already used fails and creates nothing. Call this only after the " +
      "user has said what the new agent should be; this tool does not ask " +
      "them. The role is sent as text (role) or read from a text file in " +
      "the machine (role_file): send exactly one of the two.",
    parameters: createSchema,
    execute: async (_id, params): Promise<ToolResult> => {
      // An optional field the model chose not to fill arrives as `null`
      // (validate.ts reads it that way for required ones). Treating it as
      // sent would hand `null` to the core, whose `.trim()` cannot take it.
      const inline = params.role ?? undefined;
      const requested = params.role_file ?? undefined;
      let role: string;
      let source: string | undefined;
      if (requested !== undefined) {
        if (inline !== undefined) {
          throw new CoreError(
            "Send either role (the text) or role_file (a file holding it), " +
              "not both.",
            "invalid",
          );
        }
        const read = await roleFromFile(files, requested);
        role = read.role;
        source = read.path;
      } else if (inline !== undefined) {
        role = inline;
      } else {
        throw new CoreError(
          "Send role (the text) or role_file (the path of a file holding it).",
          "invalid",
        );
      }
      const agent = create({ name: params.name, role });
      // Saying where the role came from is what lets the model tell the user
      // which file was used; the file itself is not kept anywhere.
      const origin = source === undefined
        ? ""
        : `\nIts role was read from ${source}.`;
      return {
        content: [{
          type: "text",
          text: `Created the agent "${agent.name}".${origin}\n\n` +
            "Its role is in its system prompt, so it works that way from its " +
            "first turn. It appears in the sidebar; the user opens it there, " +
            "and this conversation does not switch to it.",
        }],
        details: { id: agent.id, name: agent.name },
      };
    },
  };
}
