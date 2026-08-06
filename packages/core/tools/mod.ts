import type { AgentTool } from "npm:@earendil-works/pi-agent-core@0.83.0";
import type { Workspace } from "../types/workspace.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import {
  createEditFileTool,
  createListDirTool,
  createReadFileTool,
  createWriteFileTool,
} from "./filesystem.ts";
import { createBashTool } from "./bash.ts";

export interface ToolFactoryOptions {
  /** Default working directory (first workspace folder). */
  cwd: string;
  /** Extra environment variables for bash commands. */
  env?: Record<string, string>;
}

/** Build the standard coding tool set, sandboxed to a workspace. */
export function createCodingTools(
  workspace: Workspace,
  options: Partial<ToolFactoryOptions> = {},
): { tools: AgentTool[]; sandbox: Sandbox; cwd: string } {
  const cwd = options.cwd ?? workspace.folders[0] ?? Deno.cwd();
  const sandbox = new Sandbox(workspace.folders);
  const ctx = { sandbox, cwd };

  const tools: AgentTool[] = [
    createReadFileTool(ctx),
    createWriteFileTool(ctx),
    createEditFileTool(ctx),
    createListDirTool(ctx),
    createBashTool({ cwd, env: options.env }),
  ];
  return { tools, sandbox, cwd };
}

/** System prompt describing the agent and its workspace boundaries. */
export function buildSystemPrompt(workspace: Workspace): string {
  const folders = workspace.folders.map((f) => `- ${f}`).join("\n");
  return `You are Lumisca, a coding agent that works inside a workspace.

The workspace contains these folders (file access is restricted to them):
${folders}

Guidelines:
- Read files before editing them.
- Use relative or absolute paths; everything is resolved against the workspace folders.
- After making changes, verify them (run tests, builds) when appropriate.
- Ask the user when a task is ambiguous.
`;
}
