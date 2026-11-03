import type { Workspace } from "../types/workspace.ts";
import { DEFAULT_LOCALE, type Locale } from "../shared/mod.ts";
/** The machine's home, the folder its agents work in, and the account the
 * tools run as.
 *
 * Local to this module on purpose: the prompt is the one place outside the
 * machine's own code that names these paths, and tool layer -> vm/contract is
 * a dependency in the wrong direction (the machine is where the tools run,
 * not something the prompt builder must know about). vm/contract_test.ts
 * compares the values, so the copies cannot drift. */
const VM_WORKDIR = "/home/agent";
const VM_AGENTS_DIR = `${VM_WORKDIR}/agents`;
const VM_USER = "agent";

/** How a session's system prompt is built: the workspace framing for a
 * coding session, or the folder-less framing of a chat session. */
export interface SystemPromptOptions {
  /** The session's preloaded tool names: the guidelines render only the
   * sections whose tools the session actually has (see prompt-sections). */
  tools?: readonly string[];
  /** The language selected when the session started: the agent answers in
   * it for the session's whole life (see tools/language.ts). Omitted →
   * the default language (tests and callers without a setting). */
  language?: Locale;
}

/**
 * System prompt of a coding session: who the agent is, the workspace it may
 * touch, the machine it runs on, and the guidelines that apply to the tools
 * it actually has. Project memory (AGENTS.md) and the machine-level personal
 * instructions are NOT part of this prompt: they are published as context
 * messages (see ai/context-providers), so an edit reaches an open session
 * and the prompt itself stays stable.
 */
export function buildSystemPrompt(
  workspace: Workspace,
  options: SystemPromptOptions = {},
): string {
  const folders = workspace.folders.map((f) => `- ${f}`).join("\n");
  return `You are Lumisca, a coding agent that works inside a workspace.

The workspace contains these folders (file access is restricted to them):
${folders}
`;
}

/**
 * System prompt of a stella session: one conversation with one assistant,
 * working inside a virtual machine the user can watch.
 *
 * The machine is the framing, and it is stated plainly (what it is, where
 * the working directory is, that nothing outside it is reachable) because
 * that is the model's whole world: a session whose prompt still talked about
 * workspaces and folder pickers would have it looking for things that are not
 * there. Everything else — the tools, the guidelines — is the coding set,
 * since the work inside the machine is coding work.
 */
export function buildStellaSystemPrompt(
  options: SystemPromptOptions & {
    /** The role this agent was created with (in the user's words), or absent
     * for an agent without one. This is what makes one stella conversation
     * different from another, so it belongs in the prompt rather than in a
     * first message.
     *
     * The agent's NAME is deliberately not here: it labels a sidebar row and
     * a header, and the user can change it at any time. A prompt snapshot is
     * written once per session, so a name in it would either freeze the old
     * one (the agent introducing itself under a name the user already
     * replaced) or force a rewrite — which costs the provider's cached prefix
     * on every rename. The model is a helpful assistant; who it is to the
     * USER is the label on the row, not something it needs to know. */
    agent?: { role: string };
    /** The session's working folder inside the machine (relative paths and
     * bash start there). Omitted → the machine's home, which is what a
     * conversation without an agent's folder gets. */
    workdir?: string;
  } = {},
): string {
  // The persona, when the session has one. Written first because it is the
  // most specific fact about this session: a reader (and the model) should
  // know what it is for before being told what the machine is. An agent
  // without a role gets the opening line alone.
  const workdir = options.workdir ?? VM_WORKDIR;
  const role = options.agent?.role ?? "";
  const persona = `You are a helpful assistant.${role === "" ? "" : ` ${role}`}

`;
  return `${persona}You are Lumisca, a general-purpose assistant working inside a virtual
machine that belongs to this conversation.

The machine is a Linux desktop with a shell, a browser and a screen. Nothing
outside it is reachable — deliberate, so you experiment freely. Your working
folder is ${workdir} (~ is ${VM_WORKDIR}): the file tools resolve relative
paths there and bash starts there. Your account is \`${VM_USER}\` and \`sudo\`
works without a password (use \`sudo -n\` for anything non-interactive); the
machine's own screen services — Xvfb, openbox, Chromium, x11vnc, websockify
— are what you are looking at, so leave them alone unless the task is about
them. Other agents have sibling folders under ${VM_AGENTS_DIR}; change their
files only when the user asks.

You talk with the user in a single, ongoing chat. To send a message or reply
to the user you MUST use the send_chat tool: anything you write without it is
not shown to them. Whatever you want the user to read, send it explicitly with
send_chat.
`;
}

/**
 * System prompt of a chat session ("simple chat" without a workspace): no
 * workspace folders, no file/shell surface — the chat tool set is
 * ask / todo / skills / MCP. Sections whose tools are absent are pruned by
 * their `requires`, so the prompt never mentions a tool the session lacks.
 */
export function buildChatSystemPrompt(
  options: SystemPromptOptions = {},
): string {
  return `You are Lumisca, a helpful AI assistant.

You are running without a file workspace: the file, shell and sub-agent tools
are unavailable, so you cannot read, write or execute anything on this
machine. Answer questions, explain things, and help with text-based tasks.
Images can be attached to prompts.
`;
}
