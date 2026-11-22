import type { Workspace } from "../domain/workspace.ts";
import { appHelp, UI_HELP, UI_HELP_INLINE } from "../shared/ui-app/help.ts";

/** The card section of a prompt: the pointer alone, or the pointer and the
 * whole guide when the experimental switch puts it in the prompt. */
function appUiSection(inPrompt: boolean): string {
  return inPrompt ? `${UI_HELP_INLINE}\n\n${appHelp()}` : UI_HELP;
}

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
 * an identical string. The one install-wide switch that does reach here is
 * `appUiGuide`: moving it rebuilds the open sessions, so it is fixed for the
 * life of an agent like the tool set is.
 */
export function buildSystemPrompt(
  workspace: Workspace,
  options: {
    /** Put the whole app-card guide in the prompt instead of pointing at
     * the `app-ui` skill (the experimental switch). */
    appUiGuide?: boolean;
  } = {},
): string {
  const folders = workspace.folders.map((f) => `- ${f}`).join("\n");
  return `You are Lumisca, a coding agent that works inside a workspace.

The workspace contains these folders (file access is restricted to them):
${folders}

${appUiSection(options.appUiGuide === true)}
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
 * set did. `send_chat` is the exception: which of its two channels reaches
 * the user is a rule about the conversation, not about the tool, so no tool
 * description can state it. MEMORY.md is named for the same reason: that the
 * file exists and is meant to be kept short and organized is a convention
 * about the conversation, not a contract of `read` or `write`.
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
     * know.
     *
     * The identity is the text the agent wrote about itself. It is read when
     * the prompt is generated and fixed from then on: a write does not touch
     * the live prompt, because the prompt is the prefix the provider caches.
     * A compaction regenerates the prompt (see AgentFactory.ensureSystemPrompt
     * and SessionAgentOptions.refreshSystemPrompt), and that is where a later
     * identity reaches the model. */
    agent?: { role: string; identity?: string };
    /** The session's working folder inside the machine (relative paths and
     * bash start there). Omitted → the machine's home, which is what a
     * conversation without an agent's folder gets. */
    workdir?: string;
    /** Put the whole app-card guide in the prompt instead of pointing at
     * the `app-ui` skill (the experimental switch). */
    appUiGuide?: boolean;
  } = {},
): string {
  // The persona, when the session has one. Written first because it is the
  // most specific fact about this session: a reader (and the model) should
  // know what it is for before being told what the machine is. An agent
  // without a role gets the opening line alone.
  const workdir = options.workdir ?? VM_WORKDIR;
  const role = options.agent?.role ?? "";
  const identity = options.agent?.identity ?? "";
  const identitySection =
    identity === ""
      ? ""
      : `

Your identity: the text you wrote about yourself with the identity tool. It
is your standing description of who you are and what you know, and it is
separate from the role the user gave you at creation — that one stays as
they wrote it.

<identity>
${identity}
</identity>`;
  const persona = `You are a helpful assistant.${role === "" ? "" : ` ${role}`}${identitySection}

`;
  return `${persona}You work inside a Linux desktop that belongs to this conversation:
a shell, a browser and a screen, and nothing outside it. Your folder is
${workdir}, where file tools resolve paths and bash starts. You are
\`${VM_USER}\` with passwordless \`sudo\`. Leave the screen services (Xvfb,
openbox, Chromium, x11vnc, websockify) alone unless the task is about them.
A GUI program is started with \`vm_launch\`: that is what opens it on your
desktop. One started from \`bash\` opens on the machine's own screen, which no
conversation shows.

Your folder holds MEMORY.md, where you keep notes for later runs: write
there, with the ordinary file tools, what you should remember next time —
how this user wants things done, what you set up, where you put it —
without being asked, and read it before work that may depend on an earlier
run, because you may have written something there already. Keep it short
enough to find things in: regroup it, and delete what is no longer true,
rather than appending until nothing can be found.

Your reply is the message the user reads: the text of the run's last
message, and nothing else. Text written in a message that also calls a tool
is working notes — the user never sees it — so say what you are about to do
through send_chat rather than beside a command. A file reaches the user only
through send_chat's \`paths\`; writing it to disk or naming it in your text
sends nothing, so never tell the user a file was sent unless a send_chat
call carried it.

A run with nothing to report replies with exactly NO_RESPONSE.
send_chat carries what a reply cannot: a file, a progress note, or the
answer to one of several requests that arrived while you were working.
When the user sends several messages in a row, answer every one of them:
use send_chat for the ones you finish before your final reply, and let the
final reply answer the rest. Answering only the last leaves the others
without a response.

${appUiSection(options.appUiGuide === true)}
`;
}

/**
 * System prompt of a chat session ("simple chat" without a workspace): no
 * workspace folders, no file/shell surface — the chat tool set is
 * ask / todo / skills / MCP. The prompt names no tool, so it does not vary
 * with the set.
 */
export function buildChatSystemPrompt(
  options: {
    /** Put the whole app-card guide in the prompt instead of pointing at
     * the `app-ui` skill (the experimental switch). */
    appUiGuide?: boolean;
  } = {},
): string {
  return `You are Lumisca, a helpful AI assistant. You have no file, shell or
sub-agent tools: you cannot read, write or run anything. Images can be
attached to prompts.

${appUiSection(options.appUiGuide === true)}
`;
}
