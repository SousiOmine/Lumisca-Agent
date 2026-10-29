import type { Workspace } from "../types/workspace.ts";
import { DEFAULT_LOCALE, type Locale } from "../shared/mod.ts";
import {
  buildEnvironmentSection,
  type EnvironmentModel,
} from "../environment.ts";
import { outputLanguageSection } from "./language.ts";
import {
  CHAT_PROMPT_SECTIONS,
  CODING_PROMPT_SECTIONS,
  type PromptSection,
  renderPromptSections,
  STELLA_PROMPT_SECTIONS,
} from "./prompt-sections.ts";

/** How a session's system prompt is built: the workspace framing for a
 * coding session, or the folder-less framing of a chat session. */
export interface SystemPromptOptions {
  /** The session's preloaded tool names: the guidelines render only the
   * sections whose tools the session actually has (see prompt-sections). */
  tools?: readonly string[];
  /** The session's model, shown in the environment section. */
  model?: EnvironmentModel;
  /** The language selected when the session started: the agent answers in
   * it for the session's whole life (see tools/language.ts). Omitted →
   * the default language (tests and callers without a setting). */
  language?: Locale;
}

/** The "Guidelines:" block, filled from the sections visible for the
 * session's tool set. The output-language rule leads the list: it applies
 * to every reply, whatever tools the session has. */
function guidelines(
  sections: readonly PromptSection[],
  toolNames: readonly string[],
  language: Locale,
): string {
  return `\n\nGuidelines:\n${
    renderPromptSections(
      [outputLanguageSection(language), ...sections],
      toolNames,
    )
  }`;
}

/**
 * System prompt of a coding session: who the agent is, the workspace it may
 * touch, the machine it runs on, and the guidelines that apply to the tools
 * it actually has. Project memory (AGENTS.md) and the machine-level personal
 * instructions are NOT part of this prompt: they are published as context
 * messages (see agent/context-providers), so an edit reaches an open session
 * and the prompt itself stays stable.
 */
export function buildSystemPrompt(
  workspace: Workspace,
  options: SystemPromptOptions = {},
): string {
  const folders = workspace.folders.map((f) => `- ${f}`).join("\n");
  return `You are Lumisca, a coding agent that works inside a workspace.

The workspace contains these folders (file access is restricted to them):
${folders}${buildEnvironmentSection(options.model)}${
    guidelines(
      CODING_PROMPT_SECTIONS,
      options.tools ?? [],
      options.language ?? DEFAULT_LOCALE,
    )
  }
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
    /** Who this session is talking as: the agent's name and the role it was
     * created with. This is what makes one stella conversation different from
     * another, so it belongs in the prompt rather than in a first message. */
    agent?: { name: string; role: string };
  } = {},
): string {
  // The persona, when the session has one. Written first because it is the
  // most specific fact about this session: a reader (and the model) should
  // know who this is before being told what the machine is.
  const persona = options.agent === undefined
    ? ""
    : `You are "${options.agent.name}".${
      options.agent.role === "" ? "" : ` ${options.agent.role}`
    }

`;
  return `${persona}You are Lumisca, a general-purpose assistant working inside a virtual
machine that belongs to this conversation.

The machine is a Linux desktop: a shell, a browser and a screen are there for
whatever the work needs. Your home and working directory is /home/agent; the
file tools resolve paths inside it, and bash starts there. Nothing outside
the machine is reachable — that is deliberate: you experiment freely, and a
mistake costs nothing on the user's own computer.

You talk with the user in a single, ongoing chat. There is no session list
and no workspace to pick: this one conversation is the whole context, and it
grows over time.${buildEnvironmentSection(options.model)}${
    guidelines(
      STELLA_PROMPT_SECTIONS,
      options.tools ?? [],
      options.language ?? DEFAULT_LOCALE,
    )
  }
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
Images can be attached to prompts.${buildEnvironmentSection(options.model)}${
    guidelines(
      CHAT_PROMPT_SECTIONS,
      options.tools ?? [],
      options.language ?? DEFAULT_LOCALE,
    )
  }
`;
}
