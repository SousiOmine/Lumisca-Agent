import type { Workspace } from "../types/workspace.ts";
import { loadProjectMemory } from "../memory/agents-md.ts";
import {
  buildEnvironmentSection,
  type EnvironmentModel,
} from "../environment.ts";
import { formatAvailableSkills, type SkillDef } from "../skills/discover.ts";
import { sessionSkills } from "./toolsets.ts";

/** Personalization budget (same cap as project memory). */
const MAX_PERSONALIZATION_BYTES = 32 * 1024;

/** Guidelines shared by the coding and chat prompts (single source so a
 * wording change applies to both). */
function sharedGuidelines(): string {
  return `- Ask the user when a task is ambiguous.
- Prioritize correctness above all else.
- Never fabricate tool or test results.
- Do not silently narrow the requested scope.`;
}

/** System prompt describing the agent and its workspace boundaries.
 * `personalInstructions` (the machine-level AGENTS.md next to the settings
 * file) is appended at the very end, after project memory. `model` (the
 * session's model, when known) appears in the environment section between
 * the workspace folders and the guidelines. `browserAvailable` (whether
 * the session has a browser backend attached) gates the built-in
 * web-browser skill's presence in the <available_skills> listing; callers
 * that know the backend state must pass it, the default (false) never
 * advertises. */
export function buildSystemPrompt(
  workspace: Workspace,
  personalInstructions?: string,
  model?: EnvironmentModel,
  browserAvailable = false,
): string {
  const folders = workspace.folders.map((f) => `- ${f}`).join("\n");
  const memory = loadProjectMemory(workspace.folders);
  const memorySection = memory
    ? `\n\n# Project memory (AGENTS.md)\n${memory}`
    : "";
  const skills = sessionSkills(workspace.folders, { browserAvailable });
  return `You are Lumisca, a coding agent that works inside a workspace.

The workspace contains these folders (file access is restricted to them):
${folders}${buildEnvironmentSection(model)}

Guidelines:
- Paths are either absolute or relative to the workspace. A relative path must
  start with the name of a workspace folder above, e.g. \`Aaa/README.md\`.
- Long-running commands (dev servers, watchers, downloads) should be started
  with async_bash instead of bash: it returns immediately and the command
  keeps running after the run ends. Check progress with async_bash_status,
  stop a command with async_bash_kill.
- A user message starting with "[Background command ...]" is a system
  notification about a background command, not a message from the user:
  acknowledge it, but do not mistake it for user input.
- Delegate independent work to sub-agents with the task tool: it starts the
  agent in the background and returns immediately, so keep working while it
  runs. The result arrives as a "[Task ...]" notification, or fetch it with
  task_output (wait: true) when your next step depends on it. Reach a
  running sub-agent with send_message.
- A user message starting with "[Task ...]" or "[Message from ...]" is a
  system notification from a sub-agent or another agent, not a message from
  the user: acknowledge it, but do not mistake it for user input.
- Use the dedicated tools: read to read files, edit to edit them, grep to
  search, glob to explore structure.
- Use eval for quick calculations and data processing instead of spawning
  python or node from bash.
- Plan multi-step work with the todo tool (phases and tasks) and keep it
  up to date as you go; completing the current task advances automatically.
  The user watches your progress live in the UI.
- After making changes, verify them (run tests, builds) when appropriate.
${sharedGuidelines()}
- Write code with future maintainers in mind.
- Avoid unnecessary allocations and computation.
- Never discard changes the user has already made.
- For multi-file changes, plan before editing, investigate existing patterns
  before implementing, and fix root causes rather than symptoms. Do a clean
  cutover: leave no old callers or compatibility shims behind.
- Do not stop halfway: carry the work through until the deliverable is
  complete.
- Do not hand in TODOs or placeholder implementations as finished work.
- Do not ask the user for information you can obtain from your tools.
${memorySection}${skillsListingSection(skills)}${
    personalInstructionsSection(personalInstructions)
  }
`;
}

/** The `<available_skills>` section of a system prompt, shared by every
 * prompt builder (coding and chat): one line per skill, capped at
 * MAX_AVAILABLE_SKILLS_BYTES (skills past the cap stay loadable via the
 * skill tool by name). Empty when there are no skills. */
function skillsListingSection(skills: SkillDef[]): string {
  if (skills.length === 0) return "";
  return `\n\n# Skills\nSkills are reusable instructions stored as SKILL.md files. ` +
    `When a task matches one of the skills below, load it with the skill ` +
    `tool — the tool returns the skill's full instructions (and can read ` +
    `additional files from the skill directory via read_followup).\n` +
    `<available_skills>\n${formatAvailableSkills(skills)}\n</available_skills>`;
}

/** The personal-instructions (machine-level AGENTS.md) section appended at
 * the very end of every prompt, capped at MAX_PERSONALIZATION_BYTES.
 * Empty when no personal instructions are configured. */
function personalInstructionsSection(
  personalInstructions?: string,
): string {
  const personal = (personalInstructions ?? "").trim();
  if (personal.length === 0) return "";
  return `\n\n# Personal instructions (AGENTS.md)\n${
    personal.length > MAX_PERSONALIZATION_BYTES
      ? personal.slice(0, MAX_PERSONALIZATION_BYTES)
      : personal
  }`;
}

/** System prompt for a chat session ("simple chat" without a workspace):
 * no workspace folders, no file/shell surface — the chat tool set is
 * ask / todo / global skills / MCP. There are no background commands and
 * no sub-agents, so the prompt never mentions their notifications.
 * `personalInstructions` (the machine-level AGENTS.md) is appended at the
 * very end; `model` appears in the environment section;
 * `browserAvailable` gates the built-in web-browser skill like
 * buildSystemPrompt does. */
export function buildChatSystemPrompt(
  personalInstructions?: string,
  model?: EnvironmentModel,
  browserAvailable = false,
): string {
  const skills = sessionSkills([], { browserAvailable });
  return `You are Lumisca, a helpful AI assistant.

You are running without a file workspace: the file, shell and sub-agent tools
are unavailable, so you cannot read, write or execute anything on this
machine. Answer questions, explain things, and help with text-based tasks.
Images can be attached to prompts.${buildEnvironmentSection(model)}

Guidelines:
${sharedGuidelines()}
- Write answers with future readers in mind.
- Do not hand in placeholder content as finished work.
- Do not ask the user for information you can obtain yourself.${
    skillsListingSection(skills)
  }${personalInstructionsSection(personalInstructions)}
`;
}
