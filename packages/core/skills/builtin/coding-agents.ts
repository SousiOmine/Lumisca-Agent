import type { SkillDef } from "../discover.ts";

/**
 * The built-in "coding-agents" skill: how to hand a coding job to
 * sub-agents (the `task` tool).
 *
 * The tool is preloaded in a coding session, but a stella conversation had
 * nothing telling its agent when the work is big enough to split. This skill
 * is that rule: a job the user asked for, or one the agent judged to be a
 * program rather than an edit, is split across coding agents that run at the
 * same time.
 *
 * The tool is not in the preloaded set of every session (a sub-agent's own
 * set, and a session whose hub refused it) — that is why the flow starts
 * with tool_search rather than with the call: the skill can be read in a
 * session where the tool has to be found first, and the same words work in
 * both.
 */

/** The SKILL.md body. English, like the tool descriptions it quotes. */
const SKILL_MD = `# Handing coding work to sub-agents

A sub-agent is another coding agent with its own context. It works on one
self-contained job, reports back, and never sees this conversation — so
splitting work across several of them is how a large change gets done
without burying this conversation in file reads.

## When to use one

- The user asks for a coding job (implement this, fix that, port this over).
- You judge that the work is a program rather than an edit: more than one
  file, more than one concern, or something you would describe to a
  colleague before starting.
- Do NOT delegate a quick fix you can finish in a few tool calls, a
  question, or work that needs the conversation's history. Do it yourself.

## Several at once

Sub-agents run in the background. Up to 8 may run at the same time in one
session, so a job with independent parts is split into parts and all of them
started before waiting for any:

1. Decide the parts. They must not need each other's output, and they must
   not edit the same files — two agents writing one file is a conflict you
   will have to untangle.
2. Start every part with its own \`task\` call, one after another, in the
   same turn. Do not wait for the first to finish before starting the
   second: that is the serial version of the same work.
3. Then collect: \`task_output\` with \`wait: true\` for each id, or read the
   \`[Task <id> ...]\` notifications as they arrive.
4. Integrate what they produced yourself, and check it as a whole.

Keep the parts small enough to describe in two sentences. A part that needs
several paragraphs of instructions is a part that will come back wrong.

## Which kind

- \`general\` — a full coding agent: reads, writes, runs commands, and may
  itself start sub-agents. This is the one to use for implementation.
- \`explore\` — read-only research: finds things out and reports; it cannot
  change anything. Use it when the work is "find out how X works" rather
  than "change X".

## The prompt

The sub-agent starts with no context. Every \`task\` call therefore carries:

- what to achieve (not how you would do it — it decides that),
- the files and paths involved, with the facts it cannot discover quickly,
- the constraints (what must not change, which tests must pass),
- what to report back: the files it touched, what it verified, what it
  could not do.

Do not paste this conversation into it. Do not tell it to "see above" — there
is no above.

## The flow

1. tool_search with the query "task sub-agent" (or "coding agent") to read
   the arguments of \`task\`.
2. tool_call with name "task", one call per part, all in this turn.
3. tool_call with name "task_output" to collect each one.

If tool_search does not list a sub-agent tool, this session cannot start
one: do the work yourself rather than looking for another way in.

## While they run

You can keep working — read files, plan, write the part that is yours. Do not
duplicate a part you delegated, and do not edit files you gave to an agent
that is still running. When a report arrives, treat it as work to review, not
as a result you can trust unread.
`;

/** Build the built-in coding-agents skill definition. Content is embedded
 * (no filesystem), so it survives bundling and any working directory. */
export function codingAgentsSkill(): SkillDef {
  return {
    name: "coding-agents",
    description:
      "Handing coding work to sub-agents: when a job is big enough to split, " +
      "running several coding agents at the same time (up to 8), what their " +
      "prompts must carry, and collecting their reports — the `task` tool, " +
      "found with tool_search when it is not preloaded.",
    source: "builtin",
    read: (relativePath) => {
      if (relativePath !== undefined) {
        // One file per built-in skill: no follow-up files exist. The message
        // mirrors the file-based skills' read error.
        return Promise.reject(
          new Error(
            `No such file in skill "coding-agents": ${relativePath}`,
          ),
        );
      }
      return Promise.resolve(SKILL_MD);
    },
  };
}
