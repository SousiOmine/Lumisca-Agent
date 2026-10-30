import type { SkillDef } from "../discover.ts";

/**
 * The built-in "agent-create" skill: how to add another counterpart to the
 * sidebar (the `agent_create` tool).
 *
 * The tool is discoverable rather than preloaded (see tools/registries.ts and
 * agent/factory.ts): it belongs to this conversation's own agent, so it must
 * not reach its sub-agents through tool_search. That leaves the main agent
 * without a bullet in its system prompt, and an agent that does not know it
 * may create another counterpart never offers to — this skill is what tells
 * it, and how to ask the two questions the tool cannot.
 *
 * A code-mode session must not advertise it (BuiltinContext.stella).
 */

/** The SKILL.md body. English, like the tool descriptions it quotes. */
const SKILL_MD = `# Creating another agent

An agent is a counterpart with one ongoing conversation, one working folder
and its own identity. Creating another one gives a different job its own
history and its own way of working.

## When to create one

- The user asks for another counterpart, a separate role, or an agent for a
  different job.
- The work is long-running and belongs to another role: it would bury this
  conversation, or it needs a different way of working.
- Do not create one for a one-off answer, to store notes, or to split work
  you can finish here. Do the work yourself instead.
- Create one per request unless the user asks for several.

## Ask before creating

Ask for two things with chat_ui, in one card with one <Form>:

<Card title="...">
<Text>...</Text>
<Form submit="...">
<Field label="Name" type="text" required placeholder="Researcher" />
<Field label="Role" type="text" required placeholder="Reads papers and summarizes them" />
</Form>
</Card>

- Write the card, its text, the labels and the submit label in the reply
  language.
- Name: the label in the sidebar, up to 60 characters.
- Role: what the agent is responsible for and how it works, in one or two
  sentences — it becomes the new agent's system prompt, so it is the whole
  of its instructions from the first turn.
- The form is the question. Do not repeat the same questions in your text.

The answer arrives as a message with "label: value" lines. Use those values
as written; do not paraphrase, shorten or translate them.

## Create it

1. tool_search with the query "agent create" to get the arguments of
   agent_create.
2. tool_call with name "agent_create" and those arguments: name and role.
3. If it fails because the name is taken, ask the user for another name. Do
   not retry the same values.

## What the tool does

- The role becomes the new agent's system prompt, so it works that way from
  its first turn.
- It gets its own working folder, /home/agent/agents/<id>, and its own
  conversation. The machine, the skills and the screen work there the same
  way they do for you.
- It appears in the sidebar as soon as the tool returns. The user opens it
  there; this conversation stays where it is.

## After creating

Tell the user the name, what the agent will do, and that it is in the
sidebar. Do not speak for the new agent, and do not copy this conversation
into its history.
`;

/** Build the built-in agent-create skill definition. Content is embedded (no
 * filesystem), so it survives bundling and any working directory. */
export function agentCreateSkill(): SkillDef {
  return {
    name: "agent-create",
    description:
      "Creating another agent (a counterpart with its own name, role and " +
      "conversation): when a job needs a separate one, asking the user for " +
      "the name and role in a card, and creating it with agent_create — a " +
      "tool that is not preloaded, so find it with tool_search first.",
    source: "builtin",
    read: (relativePath) => {
      if (relativePath !== undefined) {
        // One file per built-in skill: no follow-up files exist. The message
        // mirrors the file-based skills' read error.
        return Promise.reject(
          new Error(
            `No such file in skill "agent-create": ${relativePath}`,
          ),
        );
      }
      return Promise.resolve(SKILL_MD);
    },
  };
}
