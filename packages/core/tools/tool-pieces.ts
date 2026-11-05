/**
 * The pieces a session's tool set is assembled FROM: the skill catalogue it
 * can see, the sandboxed file tools, the read-only investigation set, the
 * host backends and the two-backend pair a factory needs.
 *
 * These used to live in toolsets.ts, which also builds the three tool sets
 * (coding, stella, chat). The sub-agent hub needs the pieces (it builds its
 * own sets) and the factory needs the sets, so the two modules imported each
 * other: a pure builder could not be read without the hub in scope. Splitting
 * the pieces out leaves one direction — toolsets.ts imports the pieces, the
 * hub imports the pieces, and the pieces import neither.
 */
import type { Workspace } from "../types/workspace.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import { HostFileBackend } from "./host/files.ts";
import { HostCommandRunner } from "./host/command-runner.ts";
import type { FileBackend } from "./file-backend.ts";
import type { CommandRunner } from "./command-backend.ts";
import {
  createEditFileTool,
  createListDirTool,
  createReadFileTool,
  createWriteFileTool,
} from "./filesystem.ts";
import { createBashTool } from "./bash.ts";
import type { Tool } from "./schema.ts";
import { discoverPlugins } from "../plugins/discover.ts";
import { discoverSkills, type SkillDef } from "../skills/discover.ts";
import { builtinSkills } from "../skills/builtin/mod.ts";
import type { CommandSafety } from "../safety/command-safety.ts";

/** Skills for a session, in precedence order: workspace `.agents/skills`,
 * then agent plugin skills (`skills/` of `.agents/plugins` plugins), then
 * global `~/.agents/skills`, then app-embedded built-in skills — any user
 * skill shadows a same-named built-in one. Shared with the sub-agent tool
 * builders (tools/task.ts) so both agent kinds see the same skill set.
 *
 * `browserAvailable` gates the built-in web-browser skill: it is only
 * advertised when a browser backend is attached to the session, so a
 * session that can never run browser tools does not point the agent at
 * them. Undefined → the browser skill is not advertised (callers that
 * know the backend state must say so). `computerAvailable` gates the
 * built-in computer-use skill the same way: it is only advertised when the
 * machine can actually be driven AND the user enabled the feature.
 * `globalDirs` overrides the global skills directory (~/.agents/skills);
 * tests pass a fixture directory so they never read the developer's own
 * skills. */
export function sessionSkills(
  folders: string[],
  options: {
    browserAvailable?: boolean;
    computerAvailable?: boolean;
    /** Whether this session can start coding sub-agents (see the
     * coding-agents skill). */
    subagents?: boolean;
    /** Whether the session's main agent may change the app-level MCP
     * config (see the mcp-servers skill and mcp/manage-tools.ts). Omitted
     * for sub-agents, whose tool search cannot reach those tools. */
    mcpAdmin?: boolean;
    globalDirs?: string[];
  } = {},
): SkillDef[] {
  const plugins = discoverPlugins(folders);
  return discoverSkills(folders, {
    pluginSkills: plugins.flatMap((p) => p.skills),
    builtinSkills: builtinSkills({
      browser: options.browserAvailable === true,
      computer: options.computerAvailable === true,
      subagents: options.subagents === true,
      mcpAdmin: options.mcpAdmin === true,
    }),
    globalDirs: options.globalDirs,
  });
}

/** The sandboxed file tool set: read, write, edit, list_dir. The core of
 * every coding tool set (main agent and general sub-agents share it, so new
 * tools cannot drift between the two). Searching is the shell's job: bash
 * already has grep and find, and a second surface for the same directory
 * tree only makes the agent choose on every look. */
export function fileTools(files: FileBackend): Tool[] {
  return [
    createReadFileTool({ files }),
    createWriteFileTool({ files }),
    createEditFileTool({ files }),
    createListDirTool({ files }),
  ];
}

/** The read-only investigation tool set: read, list_dir, and a shell that
 * can search but not change anything (the prompt states the restriction;
 * the `explore` sub-agent is read-only by instruction, and bash is how it
 * greps and finds). */
export function readOnlyInvestigationTools(
  files: FileBackend,
  runner: CommandRunner,
  safety: CommandSafety | undefined,
): Tool[] {
  return [
    createReadFileTool({ files }),
    createListDirTool({ files }),
    createBashTool({ files, runner, safety }),
  ];
}

/** The tool backend of a workspace on this machine: files under the
 * workspace folders, commands on this host. The single place the host
 * implementations are chosen, so a caller that wants the stella VM's
 * backends has to say so explicitly. */
export function hostBackends(workspace: Workspace): {
  files: FileBackend;
  runner: CommandRunner;
} {
  return {
    files: new HostFileBackend(new Sandbox(workspace.folders)),
    runner: new HostCommandRunner(),
  };
}

/** The two backends a tool set is built on. */
export interface ToolBackends {
  files: FileBackend;
  runner: CommandRunner;
}
