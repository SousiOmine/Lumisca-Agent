import { TOOL_AGENT_CREATE } from "../shared/mod.ts";
import { object, string, type Tool } from "../tools/schema.ts";
import {
  MAX_AGENT_NAME_CHARS,
  MAX_AGENT_ROLE_CHARS,
  type StellaAgent,
} from "./agents.ts";

const createSchema = object({
  name: string(
    `Name shown in the sidebar (1-${MAX_AGENT_NAME_CHARS} characters), in ` +
      "the user's words",
  ),
  role: string(
    "What this agent is for and how it works, in the user's words: its job, " +
      "the tone it keeps, what it checks and when it asks. This becomes its " +
      `system prompt (1-${MAX_AGENT_ROLE_CHARS} characters)`,
  ),
});

export interface AgentCreateTarget {
  /** Create the agent and return it. Throws (conflict) for a taken name —
   * the core owns that rule, so the route and this tool cannot disagree. */
  create(input: { name: string; role: string }): StellaAgent;
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
 * This mirrors Terasuma's `tera_create`, minus everything that does not earn
 * its place: no separate workspace folder (the files live in the machine) and
 * no identity-rewrite tool (a role is written once, at creation).
 */
export function createAgentCreateTool(target: AgentCreateTarget): Tool<
  typeof createSchema
> {
  return {
    name: TOOL_AGENT_CREATE,
    label: "Agent Create",
    description:
      "Create another agent: a separate agent with its own name, role " +
      "and ongoing conversation, shown in the sidebar. Its role becomes its " +
      "system prompt, so it works that way from its first turn. A name that " +
      "is already used fails and creates nothing. Call this only after the " +
      "user has said what the new agent should be; this tool does not ask " +
      "them.",
    parameters: createSchema,
    execute: (_id, params) => {
      const agent = target.create({ name: params.name, role: params.role });
      return Promise.resolve({
        content: [{
          type: "text",
          text: `Created the agent "${agent.name}".\n\n` +
            "Its role is in its system prompt, so it works that way from its " +
            "first turn. It appears in the sidebar; the user opens it there, " +
            "and this conversation does not switch to it.",
        }],
        details: { id: agent.id, name: agent.name },
      });
    },
  };
}
