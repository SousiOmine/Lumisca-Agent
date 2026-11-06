import type { Workspace } from "../types/workspace.ts";
/** The machine's home, the folder its agents work in, and the account the
 * tools run as.
 *
 * Local to this module on purpose: the prompt is the one place outside the
 * machine's own code that names these paths, and tool layer -> vm/contract is
 * a dependency in the wrong direction (the machine is where the tools run,
 * not something the prompt builder must know about). vm/contract_test.ts
 * compares the values, so the copies cannot drift. */
const VM_WORKDIR = "/home/agent";
const VM_USER = "agent";

/**
 * System prompt of a coding session: who the agent is and the workspace it
 * may touch. Project memory (AGENTS.md) and the machine-level personal
 * instructions are NOT part of this prompt: they are published as context
 * messages (see ai/context-providers), so an edit reaches an open session.
 *
 * Nothing that varies while a session lives is an argument here — not the
 * tool set, not the reply language (both are context messages). That is not
 * a simplification: a session re-derives its prompt on every open and
 * rewrites it only when the string differs (see
 * AgentFactory.ensureSystemPrompt), which needs unchanged inputs to produce
 * an identical string.
 */
export function buildSystemPrompt(workspace: Workspace): string {
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
 * there. The tools themselves are not named here — their descriptions carry
 * their contracts, and a prompt that listed them would change whenever the
 * set did.
 */
export function buildStellaSystemPrompt(
  options: {
    /** The role this agent was created with (in the user's words), or absent
     * for an agent without one. This is what makes one stella conversation
     * different from another, so it belongs in the prompt rather than in a
     * first message.
     *
     * The agent's NAME is deliberately not here: it labels a sidebar row and
     * a header, and the user can change it at any time. The prompt is
     * re-derived on every open and rewritten only when it differs (see
     * AgentFactory.ensureSystemPrompt), so a name in it would either freeze
     * the old one (the agent introducing itself under a name the user
     * already replaced) or force a rewrite — which costs the provider's
     * cached prefix on every rename. The model is a helpful assistant; who
     * it is to the USER is the label on the row, not something it needs to
     * know. */
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
  return `${persona}You work inside a Linux desktop that belongs to this conversation:
a shell, a browser and a screen, and nothing outside it. Your folder is
${workdir}, where file tools resolve paths and bash starts. You are
\`${VM_USER}\` with passwordless \`sudo\`. Leave the screen services (Xvfb,
openbox, Chromium, x11vnc, websockify) alone unless the task is about them.

Your reply is the message the user reads. A run with nothing to report
replies with exactly NO_RESPONSE. send_chat carries what a reply cannot: a
card, a file, or a progress note.
`;
}

/**
 * System prompt of a chat session ("simple chat" without a workspace): no
 * workspace folders, no file/shell surface — the chat tool set is
 * ask / todo / skills / MCP. The prompt names no tool, so it does not vary
 * with the set.
 */
export function buildChatSystemPrompt(): string {
  return `You are Lumisca, a helpful AI assistant. You have no file, shell or
sub-agent tools: you cannot read, write or run anything. Images can be
attached to prompts.
`;
}
