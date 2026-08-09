import type { Workspace } from "../types/workspace.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import {
  createEditFileTool,
  createListDirTool,
  createReadFileTool,
  createWriteFileTool,
} from "./filesystem.ts";
import { createBashTool } from "./bash.ts";
import { createGlobTool, createGrepTool } from "./search.ts";
import type { Tool } from "./schema.ts";
import { loadProjectMemory } from "../memory/agents-md.ts";

/** Personalization budget (same cap as project memory). */
const MAX_PERSONALIZATION_BYTES = 32 * 1024;

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
): { tools: Tool[]; sandbox: Sandbox; cwd: string } {
  const cwd = options.cwd ?? workspace.folders[0] ?? Deno.cwd();
  const sandbox = new Sandbox(workspace.folders);
  const ctx = { sandbox, cwd };

  const tools: Tool[] = [
    createReadFileTool(ctx),
    createWriteFileTool(ctx),
    createEditFileTool(ctx),
    createListDirTool(ctx),
    createGrepTool(ctx),
    createGlobTool(ctx),
    createBashTool({ cwd, env: options.env }),
  ];
  return { tools, sandbox, cwd };
}

/** System prompt describing the agent and its workspace boundaries.
 * `personalInstructions` (the machine-level AGENTS.md next to the settings
 * file) is appended at the very end, after project memory. */
export function buildSystemPrompt(
  workspace: Workspace,
  personalInstructions?: string,
): string {
  const folders = workspace.folders.map((f) => `- ${f}`).join("\n");
  const memory = loadProjectMemory(workspace.folders);
  const memorySection = memory
    ? `\n\n# Project memory (AGENTS.md)\n${memory}`
    : "";
  const personal = (personalInstructions ?? "").trim();
  const personalSection = personal
    ? `\n\n# Personal instructions (AGENTS.md)\n${
      personal.length > MAX_PERSONALIZATION_BYTES
        ? personal.slice(0, MAX_PERSONALIZATION_BYTES)
        : personal
    }`
    : "";
  return `You are Lumisca, a coding agent that works inside a workspace.

The workspace contains these folders (file access is restricted to them):
${folders}

Guidelines:
- Read files before editing them.
- Use relative or absolute paths; everything is resolved against the workspace folders.
- After making changes, verify them (run tests, builds) when appropriate.
- Ask the user when a task is ambiguous.
${memorySection}${personalSection}
`;
}
